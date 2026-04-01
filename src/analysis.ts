import {
  type DailyBasicRecord,
  type FinaIndicatorRecord,
  type StockBasicRecord,
  type TuShareClient,
  formatPercent,
  formatShanghaiDate,
  formatWan,
  getStockUniverse,
  normalizeYmd,
  pickLatestDate,
  shiftYmd,
  trimDecimals,
} from "./tushare.js";
import {
  buildCninfoCompanyProfileUrl,
  fetchCninfoPerformanceDisclosures,
  fetchCninfoPeriodicReports,
  getCninfoStockUniverse,
} from "./cninfo.js";

const EASTMONEY_SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get";
const EASTMONEY_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const EASTMONEY_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get";

export type StockLookupCandidate = {
  tsCode: string;
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  area?: string;
  listDate?: string;
  quoteId?: string;
  orgId?: string;
  score: number;
  matchReason: string;
};

type LookupRecord = StockBasicRecord & {
  quoteId?: string;
  orgId?: string;
};

export type FundamentalsReport =
  | {
      ok: false;
      query: string;
      reason: "not_found" | "ambiguous";
      message: string;
      candidates?: StockLookupCandidate[];
    }
  | {
      ok: true;
      query: string;
      resolved: {
        tsCode: string;
        symbol: string;
        name: string;
        market?: string;
        industry?: string;
        area?: string;
        listDate?: string;
      };
      source: "tushare" | "public_quote";
      coverage: "full" | "basic";
      snapshot: {
        tradeDate: string;
        peTtm: number | null;
        pb: number | null;
        turnoverRatePct: number | null;
        volumeRatio: number | null;
        totalMvWan: number | null;
        circMvWan: number | null;
      };
      profitability: {
        reportEndDate?: string;
        annDate?: string;
        roePct: number | null;
        grossMarginPct: number | null;
        netProfitMarginPct: number | null;
        debtToAssetsPct: number | null;
        revenueYoyPct: number | null;
        netProfitYoyPct: number | null;
      };
      quickTake: {
        valuation: string;
        style: string;
        strengths: string[];
        risks: string[];
      };
      references?: {
        officialSource: "cninfo";
        companyProfileUrl?: string;
        periodicReports: Array<{
          title: string;
          publishedAt: string;
          pdfUrl?: string;
        }>;
        performanceDisclosures: Array<{
          title: string;
          publishedAt: string;
          pdfUrl?: string;
        }>;
      };
      formatted: {
        totalMv: string | null;
        circMv: string | null;
        peTtm: string | null;
        pb: string | null;
        turnoverRate: string | null;
        roe: string | null;
        grossMargin: string | null;
        netProfitMargin: string | null;
        debtToAssets: string | null;
        revenueYoy: string | null;
        netProfitYoy: string | null;
      };
      dataTime: {
        fundamentalsTradeDate: string;
        financialReportEndDate?: string;
        financialAnnDate?: string;
      };
    };

export type AuctionHotspotReport = {
  ok: true;
  tradeDate: string;
  requestedTradeDate?: string;
  usedLatestAvailable: boolean;
  screening: {
    minVolumeRatio: number;
    minTurnoverRatePct: number;
    minAuctionChangePct: number;
    topN: number;
  };
  leaders: Array<{
    tsCode: string;
    name: string;
    industry: string;
    auctionChangePct: number;
    volumeRatio: number | null;
    turnoverRatePct: number | null;
    amount: number;
    amountWan: number;
    floatMarketValueWan: number | null;
    floatMarketValue: string | null;
  }>;
  sectors: Array<{
    industry: string;
    stockCount: number;
    totalAmountWan: number;
    avgAuctionChangePct: number;
    avgVolumeRatio: number;
    leaders: string[];
  }>;
  capitalFlowInference: {
    riskAppetite: "high" | "medium" | "low";
    concentration: "high" | "medium" | "low";
    dominantStyle: "large-cap" | "small-cap" | "balanced";
    notes: string[];
    largeCapSharePct: number;
    smallCapSharePct: number;
    top3SectorSharePct: number;
  };
  caveats: string[];
};

export type DisclosureAnalysisReport =
  | {
      ok: false;
      query: string;
      reason: "not_found" | "ambiguous";
      message: string;
      candidates?: StockLookupCandidate[];
    }
  | {
      ok: true;
      query: string;
      resolved: {
        tsCode: string;
        symbol: string;
        name: string;
        market?: string;
      };
      officialSource: "cninfo";
      companyProfileUrl: string;
      periodicReports: Array<{
        title: string;
        publishedAt: string;
        pdfUrl?: string;
        reportType: "annual" | "half-year" | "q1" | "q3" | "other";
      }>;
      performanceDisclosures: Array<{
        title: string;
        publishedAt: string;
        pdfUrl?: string;
      }>;
      analysis: {
        latestPeriodicReport?: string;
        latestPerformanceDisclosure?: string;
        disclosureRhythm: string;
        focus: string[];
        risks: string[];
      };
    };

export async function lookupStocks(
  client: TuShareClient,
  query: string,
  limit = 5,
): Promise<StockLookupCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalizedCode = normalizeStockCode(trimmed);
  if (normalizedCode) {
    const directMatches = await client.getStockBasic({ tsCode: normalizedCode, listStatus: "L" });
    if (directMatches.length > 0) {
      return rankLookupMatches(directMatches, trimmed).slice(0, limit);
    }
    const symbolMatches = await client.getStockBasic({
      symbol: normalizedCode.slice(0, 6),
      listStatus: "L",
    });
    return rankLookupMatches(symbolMatches, trimmed).slice(0, limit);
  }

  const exactMatches = await client.getStockBasic({ name: trimmed, listStatus: "L" });
  if (exactMatches.length > 0) {
    return rankLookupMatches(exactMatches, trimmed).slice(0, limit);
  }

  const universe = await getStockUniverse(client);
  return rankLookupMatches(
    universe.filter((record) => {
      const lowerQuery = trimmed.toLowerCase();
      return (
        record.name.toLowerCase().includes(lowerQuery) ||
        record.symbol.toLowerCase().includes(lowerQuery) ||
        record.tsCode.toLowerCase().includes(lowerQuery)
      );
    }),
    trimmed,
  ).slice(0, limit);
}

export async function lookupStocksPublic(
  query: string,
  limit = 5,
): Promise<StockLookupCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [eastmoneyRecords, cninfoRecords] = await Promise.all([
    fetchEastmoneyLookupRecords(trimmed, limit),
    fetchCninfoLookupRecords(),
  ]);

  const merged = new Map<string, LookupRecord>();
  for (const record of cninfoRecords) {
    merged.set(record.tsCode, record);
  }

  for (const record of eastmoneyRecords) {
    const existing = merged.get(record.tsCode);
    merged.set(record.tsCode, {
      ...(existing ?? {}),
      ...record,
      orgId: existing?.orgId ?? record.orgId,
      area: existing?.area,
      listDate: existing?.listDate,
    });
  }

  return rankLookupMatches([...merged.values()], trimmed).slice(0, limit);
}

export async function buildFundamentalsReport(
  client: TuShareClient,
  query: string,
  tradeDate?: string,
): Promise<FundamentalsReport> {
  const candidates = await lookupStocks(client, query, 5);
  if (candidates.length === 0) {
    return {
      ok: false,
      query,
      reason: "not_found",
      message: `No A-share stock matched "${query}".`,
    };
  }

  const exactWinner = chooseResolvedCandidate(query, candidates);
  if (!exactWinner) {
    return {
      ok: false,
      query,
      reason: "ambiguous",
      message: `Query "${query}" matched multiple stocks. Ask the user to pick one.`,
      candidates,
    };
  }

  const latestDaily = await fetchLatestDailyBasic(client, exactWinner.tsCode, tradeDate);
  const latestFina = await fetchLatestFinaIndicator(client, exactWinner.tsCode);

  const quickTake = buildQuickTake(latestDaily, latestFina, exactWinner);
  const references = await buildCninfoReferences(exactWinner, exactWinner.name);

  return {
    ok: true,
    query,
    resolved: {
      tsCode: exactWinner.tsCode,
      symbol: exactWinner.symbol,
      name: exactWinner.name,
      market: exactWinner.market,
      industry: exactWinner.industry,
      area: exactWinner.area,
      listDate: exactWinner.listDate,
    },
    source: "tushare",
    coverage: "full",
    snapshot: latestDaily,
    profitability: latestFina ?? {
      roePct: null,
      grossMarginPct: null,
      netProfitMarginPct: null,
      debtToAssetsPct: null,
      revenueYoyPct: null,
      netProfitYoyPct: null,
    },
    quickTake,
    references,
    formatted: {
      totalMv: formatWan(latestDaily.totalMvWan),
      circMv: formatWan(latestDaily.circMvWan),
      peTtm: formatNullableNumber(latestDaily.peTtm),
      pb: formatNullableNumber(latestDaily.pb),
      turnoverRate: formatPercent(latestDaily.turnoverRatePct),
      roe: formatPercent(latestFina?.roePct),
      grossMargin: formatPercent(latestFina?.grossMarginPct),
      netProfitMargin: formatPercent(latestFina?.netProfitMarginPct),
      debtToAssets: formatPercent(latestFina?.debtToAssetsPct),
      revenueYoy: formatPercent(latestFina?.revenueYoyPct),
      netProfitYoy: formatPercent(latestFina?.netProfitYoyPct),
    },
    dataTime: {
      fundamentalsTradeDate: latestDaily.tradeDate,
      financialReportEndDate: latestFina?.endDate,
      financialAnnDate: latestFina?.annDate,
    },
  };
}

export async function buildPublicFundamentalsReport(
  query: string,
): Promise<FundamentalsReport> {
  const candidates = await lookupStocksPublic(query, 5);
  if (candidates.length === 0) {
    return {
      ok: false,
      query,
      reason: "not_found",
      message: `No A-share stock matched "${query}".`,
    };
  }

  const exactWinner = chooseResolvedCandidate(query, candidates);
  if (!exactWinner) {
    return {
      ok: false,
      query,
      reason: "ambiguous",
      message: `Query "${query}" matched multiple stocks. Ask the user to pick one.`,
      candidates,
    };
  }

  const quote = await fetchPublicQuote(exactWinner);
  const snapshot: DailyBasicRecord = {
    tsCode: exactWinner.tsCode,
    tradeDate: formatShanghaiDate(),
    peTtm: scaleEastmoneyPercentHundred(quote.peTtmRaw),
    pb: scaleEastmoneyPercentHundred(quote.pbRaw),
    turnoverRatePct: scaleEastmoneyPercentHundred(quote.turnoverRateRaw),
    volumeRatio: null,
    totalMvWan: quote.totalMarketValue == null ? null : quote.totalMarketValue / 10_000,
    circMvWan: quote.floatMarketValue == null ? null : quote.floatMarketValue / 10_000,
  };

  const profitability: FinaIndicatorRecord = {
    tsCode: exactWinner.tsCode,
    roePct: quote.roePct,
    grossMarginPct: null,
    netProfitMarginPct: quote.netProfitMarginPct,
    debtToAssetsPct: quote.debtToAssetsPct,
    revenueYoyPct: null,
    netProfitYoyPct: null,
  };

  const resolved = {
    tsCode: exactWinner.tsCode,
    symbol: exactWinner.symbol,
    name: exactWinner.name,
    market: exactWinner.market,
    industry: quote.industry ?? exactWinner.industry,
    area: exactWinner.area,
    listDate: exactWinner.listDate,
  };
  const quickTake = buildQuickTake(snapshot, profitability, {
    ...exactWinner,
    industry: resolved.industry,
  });
  quickTake.risks.push(
    "This fallback uses a public quote snapshot, so growth and margin detail is incomplete without TuShare.",
  );
  const references = await buildCninfoReferences(exactWinner, resolved.name);

  return {
    ok: true,
    query,
    resolved,
    source: "public_quote",
    coverage: "basic",
    snapshot,
    profitability,
    quickTake,
    references,
    formatted: {
      totalMv: formatWan(snapshot.totalMvWan),
      circMv: formatWan(snapshot.circMvWan),
      peTtm: formatNullableNumber(snapshot.peTtm),
      pb: formatNullableNumber(snapshot.pb),
      turnoverRate: formatPercent(snapshot.turnoverRatePct),
      roe: formatPercent(profitability.roePct),
      grossMargin: null,
      netProfitMargin: formatPercent(profitability.netProfitMarginPct),
      debtToAssets: formatPercent(profitability.debtToAssetsPct),
      revenueYoy: null,
      netProfitYoy: null,
    },
    dataTime: {
      fundamentalsTradeDate: snapshot.tradeDate,
    },
  };
}

export async function buildAuctionHotspotReport(
  client: TuShareClient,
  params: {
    tradeDate?: string;
    topN?: number;
    minVolumeRatio?: number;
    minTurnoverRatePct?: number;
    minAuctionChangePct?: number;
  },
): Promise<AuctionHotspotReport> {
  const requestedTradeDate = normalizeYmd(params.tradeDate);
  const topN = clampNumber(params.topN, 1, 50, 15);
  const minVolumeRatio = params.minVolumeRatio ?? 1.5;
  const minTurnoverRatePct = params.minTurnoverRatePct ?? 0.3;
  const minAuctionChangePct = params.minAuctionChangePct ?? 0;

  const anchorDate = requestedTradeDate ?? formatShanghaiDate();
  const startDate = shiftYmd(anchorDate, -7);
  const auctionRows = requestedTradeDate
    ? await client.getAuction({ tradeDate: requestedTradeDate })
    : await client.getAuction({ startDate, endDate: anchorDate });

  const usedTradeDate =
    requestedTradeDate && auctionRows.some((row) => row.tradeDate === requestedTradeDate)
      ? requestedTradeDate
      : pickLatestDate(auctionRows, (row) => row.tradeDate);

  if (!usedTradeDate) {
    throw new Error("No auction data was available for the requested date range.");
  }

  const universe = await getStockUniverse(client);
  const stockByCode = new Map(universe.map((record) => [record.tsCode, record]));
  const filteredRows = auctionRows.filter((row) => row.tradeDate === usedTradeDate);

  const enriched = filteredRows
    .map((row) => {
      const auctionChangePct = row.preClose > 0 ? ((row.price - row.preClose) / row.preClose) * 100 : null;
      if (auctionChangePct == null) return null;
      const stock = stockByCode.get(row.tsCode);
      const industry = stock?.industry?.trim() || "Unclassified";
      const floatMarketValueWan =
        row.floatShareWan != null && row.price > 0 ? row.floatShareWan * row.price : null;

      return {
        tsCode: row.tsCode,
        name: stock?.name || row.tsCode,
        industry,
        auctionChangePct,
        volumeRatio: row.volumeRatio,
        turnoverRatePct: row.turnoverRatePct,
        amount: row.amount,
        amountWan: row.amount / 10_000,
        floatMarketValueWan,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .filter(
      (row) =>
        (row.volumeRatio ?? 0) >= minVolumeRatio &&
        (row.turnoverRatePct ?? 0) >= minTurnoverRatePct &&
        row.auctionChangePct >= minAuctionChangePct,
    )
    .sort((left, right) => {
      const leftVolumeRatio = left.volumeRatio ?? 0;
      const rightVolumeRatio = right.volumeRatio ?? 0;
      if (rightVolumeRatio !== leftVolumeRatio) return rightVolumeRatio - leftVolumeRatio;
      if (right.auctionChangePct !== left.auctionChangePct) {
        return right.auctionChangePct - left.auctionChangePct;
      }
      return right.amount - left.amount;
    });

  const leaders = enriched.slice(0, topN).map((row) => ({
    ...row,
    floatMarketValue: formatWan(row.floatMarketValueWan),
  }));

  const sectors = buildSectorSummary(enriched).slice(0, 6);
  const capitalFlowInference = buildCapitalFlowInference(enriched, sectors);

  return {
    ok: true,
    tradeDate: usedTradeDate,
    requestedTradeDate,
    usedLatestAvailable: !requestedTradeDate || requestedTradeDate !== usedTradeDate,
    screening: {
      minVolumeRatio,
      minTurnoverRatePct,
      minAuctionChangePct,
      topN,
    },
    leaders,
    sectors,
    capitalFlowInference,
    caveats: [
      "Sector grouping uses stock_basic industry labels, not concept boards.",
      "Capital flow is inferred from auction amount, turnover, volume ratio, and float market value.",
    ],
  };
}

export async function buildDisclosureAnalysisReport(
  query: string,
): Promise<DisclosureAnalysisReport> {
  const candidates = await lookupStocksPublic(query, 5);
  if (candidates.length === 0) {
    return {
      ok: false,
      query,
      reason: "not_found",
      message: `No A-share stock matched "${query}".`,
    };
  }

  const exactWinner = chooseResolvedCandidate(query, candidates);
  if (!exactWinner) {
    return {
      ok: false,
      query,
      reason: "ambiguous",
      message: `Query "${query}" matched multiple stocks. Ask the user to pick one.`,
      candidates,
    };
  }

  const [periodicReports, performanceDisclosures] = await Promise.all([
    fetchCninfoPeriodicReports({
      query: exactWinner.name,
      tsCode: exactWinner.tsCode,
      limit: 6,
    }),
    fetchCninfoPerformanceDisclosures({
      query: exactWinner.name,
      tsCode: exactWinner.tsCode,
      limit: 6,
    }),
  ]);

  const normalizedPeriodicReports = periodicReports.map((record) => ({
    title: record.announcementTitle,
    publishedAt: formatCninfoDate(record.announcementTime),
    pdfUrl: record.pdfUrl,
    reportType: classifyPeriodicReport(record.announcementTitle),
  }));
  const normalizedPerformanceDisclosures = performanceDisclosures.map((record) => ({
    title: record.announcementTitle,
    publishedAt: formatCninfoDate(record.announcementTime),
    pdfUrl: record.pdfUrl,
  }));

  return {
    ok: true,
    query,
    resolved: {
      tsCode: exactWinner.tsCode,
      symbol: exactWinner.symbol,
      name: exactWinner.name,
      market: exactWinner.market,
    },
    officialSource: "cninfo",
    companyProfileUrl: buildCninfoCompanyProfileUrl(exactWinner.symbol),
    periodicReports: normalizedPeriodicReports,
    performanceDisclosures: normalizedPerformanceDisclosures,
    analysis: buildDisclosureTake(normalizedPeriodicReports, normalizedPerformanceDisclosures),
  };
}

function buildSectorSummary(
  rows: Array<{
    industry: string;
    name: string;
    amountWan: number;
    auctionChangePct: number;
    volumeRatio: number | null;
  }>,
): AuctionHotspotReport["sectors"] {
  const sectors = new Map<
    string,
    {
      industry: string;
      stockCount: number;
      totalAmountWan: number;
      totalAuctionChangePct: number;
      totalVolumeRatio: number;
      volumeCount: number;
      leaders: Array<{ name: string; amountWan: number }>;
    }
  >();

  for (const row of rows) {
    const entry =
      sectors.get(row.industry) ??
      {
        industry: row.industry,
        stockCount: 0,
        totalAmountWan: 0,
        totalAuctionChangePct: 0,
        totalVolumeRatio: 0,
        volumeCount: 0,
        leaders: [],
      };

    entry.stockCount += 1;
    entry.totalAmountWan += row.amountWan;
    entry.totalAuctionChangePct += row.auctionChangePct;
    if (row.volumeRatio != null) {
      entry.totalVolumeRatio += row.volumeRatio;
      entry.volumeCount += 1;
    }
    entry.leaders.push({ name: row.name, amountWan: row.amountWan });
    sectors.set(row.industry, entry);
  }

  return [...sectors.values()]
    .map((entry) => ({
      industry: entry.industry,
      stockCount: entry.stockCount,
      totalAmountWan: Number(trimDecimals(entry.totalAmountWan)),
      avgAuctionChangePct: Number(trimDecimals(entry.totalAuctionChangePct / entry.stockCount)),
      avgVolumeRatio: Number(
        trimDecimals(entry.volumeCount > 0 ? entry.totalVolumeRatio / entry.volumeCount : 0),
      ),
      leaders: entry.leaders
        .sort((left, right) => right.amountWan - left.amountWan)
        .slice(0, 3)
        .map((item) => item.name),
    }))
    .sort((left, right) => {
      if (right.totalAmountWan !== left.totalAmountWan) {
        return right.totalAmountWan - left.totalAmountWan;
      }
      return right.stockCount - left.stockCount;
    });
}

function buildCapitalFlowInference(
  rows: Array<{
    amountWan: number;
    auctionChangePct: number;
    volumeRatio: number | null;
    floatMarketValueWan: number | null;
  }>,
  sectors: AuctionHotspotReport["sectors"],
): AuctionHotspotReport["capitalFlowInference"] {
  const totalAmountWan = rows.reduce((sum, row) => sum + row.amountWan, 0);
  const largeCapAmountWan = rows
    .filter((row) => (row.floatMarketValueWan ?? 0) >= 1_000_000)
    .reduce((sum, row) => sum + row.amountWan, 0);
  const smallCapAmountWan = rows
    .filter((row) => (row.floatMarketValueWan ?? 0) > 0 && (row.floatMarketValueWan ?? 0) <= 300_000)
    .reduce((sum, row) => sum + row.amountWan, 0);
  const avgAuctionChangePct =
    rows.length > 0 ? rows.reduce((sum, row) => sum + row.auctionChangePct, 0) / rows.length : 0;
  const volumeRatioRows = rows.filter((row) => row.volumeRatio != null);
  const avgVolumeRatio =
    volumeRatioRows.length > 0
      ? volumeRatioRows.reduce((sum, row) => sum + (row.volumeRatio ?? 0), 0) / volumeRatioRows.length
      : 0;
  const top3SectorSharePct =
    totalAmountWan > 0
      ? (sectors.slice(0, 3).reduce((sum, sector) => sum + sector.totalAmountWan, 0) / totalAmountWan) * 100
      : 0;

  const dominantStyle =
    totalAmountWan <= 0
      ? "balanced"
      : largeCapAmountWan / totalAmountWan >= 0.55
        ? "large-cap"
        : smallCapAmountWan / totalAmountWan >= 0.55
          ? "small-cap"
          : "balanced";

  const riskAppetite =
    avgAuctionChangePct >= 2 && avgVolumeRatio >= 2
      ? "high"
      : avgAuctionChangePct >= 0.8 && avgVolumeRatio >= 1.4
        ? "medium"
        : "low";

  const concentration =
    top3SectorSharePct >= 65 ? "high" : top3SectorSharePct >= 45 ? "medium" : "low";

  const notes: string[] = [];
  if (dominantStyle === "large-cap") {
    notes.push("Auction amount is concentrated in larger float-cap names, closer to an institutional tone.");
  } else if (dominantStyle === "small-cap") {
    notes.push("Auction amount leans toward smaller float-cap names, which is closer to a trading-driven tape.");
  } else {
    notes.push("Auction amount is split across cap buckets, so the tape looks more balanced than one-way.");
  }

  if (concentration === "high") {
    notes.push("Hot money is clustered into a few industries, so crowding risk is elevated.");
  } else if (concentration === "low") {
    notes.push("Participation is spread out, which usually means the tape is exploratory rather than fully consensus.");
  }

  if (riskAppetite === "high") {
    notes.push("Gap strength and volume ratio both point to a risk-on opening.");
  } else if (riskAppetite === "low") {
    notes.push("Auction strength is mild, so expect more churn than a one-sided momentum open.");
  }

  return {
    riskAppetite,
    concentration,
    dominantStyle,
    notes,
    largeCapSharePct: Number(trimDecimals(totalAmountWan > 0 ? (largeCapAmountWan / totalAmountWan) * 100 : 0)),
    smallCapSharePct: Number(trimDecimals(totalAmountWan > 0 ? (smallCapAmountWan / totalAmountWan) * 100 : 0)),
    top3SectorSharePct: Number(trimDecimals(top3SectorSharePct)),
  };
}

function buildDisclosureTake(
  periodicReports: Array<{
    title: string;
    publishedAt: string;
    pdfUrl?: string;
    reportType: "annual" | "half-year" | "q1" | "q3" | "other";
  }>,
  performanceDisclosures: Array<{
    title: string;
    publishedAt: string;
    pdfUrl?: string;
  }>,
): {
  latestPeriodicReport?: string;
  latestPerformanceDisclosure?: string;
  disclosureRhythm: string;
  focus: string[];
  risks: string[];
} {
  const focus: string[] = [];
  const risks: string[] = [];

  const latestPeriodic = periodicReports[0];
  const latestPerformance = performanceDisclosures[0];

  if (latestPeriodic) {
    focus.push(`最新定期报告是 ${latestPeriodic.title}，披露日期 ${latestPeriodic.publishedAt}。`);
    if (latestPeriodic.reportType === "annual") {
      focus.push("优先看年报正文、审计意见、主营拆分和分红方案。");
    } else if (latestPeriodic.reportType === "half-year") {
      focus.push("半年度报告优先看收入利润增速、毛利率变化和合同负债/存货。");
    } else if (latestPeriodic.reportType === "q1" || latestPeriodic.reportType === "q3") {
      focus.push("季报优先看利润弹性、现金流和同比环比是否背离。");
    }
  } else {
    risks.push("近三年内没有检索到标准季报/年报索引，需人工去巨潮公司页二次确认。");
  }

  if (latestPerformance) {
    focus.push(`最近还有业绩类披露：${latestPerformance.title}（${latestPerformance.publishedAt}）。`);
  } else {
    risks.push("近期未检索到业绩预告/快报，短期业绩预期只能以定期报告为主。");
  }

  const reportTypes = new Set(periodicReports.map((item) => item.reportType));
  const disclosureRhythm =
    reportTypes.has("annual") && reportTypes.has("half-year") && (reportTypes.has("q1") || reportTypes.has("q3"))
      ? "定期报告节奏完整，适合顺着最新季报/年报往下看。"
      : periodicReports.length > 0
        ? "定期报告有披露，但节奏不算完整，分析时要补看缺失期间。"
        : "公开定期报告线索偏少，先看巨潮公司页和最近公告。";

  if (periodicReports.some((item) => item.title.includes("摘要"))) {
    risks.push("部分命中的是摘要版文件，做深度判断时要优先看正式全文 PDF。");
  }

  return {
    latestPeriodicReport: latestPeriodic
      ? `${latestPeriodic.title} (${latestPeriodic.publishedAt})`
      : undefined,
    latestPerformanceDisclosure: latestPerformance
      ? `${latestPerformance.title} (${latestPerformance.publishedAt})`
      : undefined,
    disclosureRhythm,
    focus,
    risks,
  };
}

function buildQuickTake(
  snapshot: DailyBasicRecord,
  fina: FinaIndicatorRecord | null,
  stock: StockLookupCandidate,
): {
  valuation: string;
  style: string;
  strengths: string[];
  risks: string[];
} {
  const strengths: string[] = [];
  const risks: string[] = [];

  if ((fina?.roePct ?? 0) >= 12) strengths.push("ROE is above 12%, which usually signals decent capital efficiency.");
  if ((fina?.grossMarginPct ?? 0) >= 25) strengths.push("Gross margin is solid, so the business has some pricing buffer.");
  if ((fina?.revenueYoyPct ?? 0) >= 15) strengths.push("Revenue growth is still positive and in a healthy range.");
  if ((fina?.netProfitYoyPct ?? 0) >= 15) strengths.push("Net profit growth is healthy, which helps validate the earnings story.");

  if ((snapshot.peTtm ?? 0) >= 50) risks.push("PE TTM is elevated, so expectations are already priced fairly high.");
  if ((fina?.debtToAssetsPct ?? 0) >= 65) risks.push("Debt-to-assets is high, so leverage risk needs watching.");
  if ((fina?.revenueYoyPct ?? 0) < 0) risks.push("Revenue growth has turned negative, which weakens the growth narrative.");
  if ((fina?.netProfitYoyPct ?? 0) < 0) risks.push("Net profit growth has turned negative, which can pressure valuation.");
  if ((snapshot.turnoverRatePct ?? 0) >= 8) risks.push("Turnover is elevated, so short-term volatility may stay high.");

  const valuation =
    snapshot.peTtm == null || snapshot.peTtm <= 0
      ? "Loss-making or distorted earnings base; PE is not very informative."
      : snapshot.peTtm <= 20 && (snapshot.pb ?? 99) <= 2.5
        ? "Valuation looks relatively restrained."
        : snapshot.peTtm <= 40
          ? "Valuation is in a middle zone."
          : "Valuation is rich and needs strong growth support.";

  const style =
    (snapshot.circMvWan ?? 0) >= 2_000_000
      ? "Larger-cap name that is more likely to trade with institutions."
      : (snapshot.circMvWan ?? 0) <= 400_000 && (snapshot.turnoverRatePct ?? 0) >= 3
        ? "Mid/small-cap name with a more active trading profile."
        : `Balanced profile in ${stock.industry ?? "its"} sector.`;

  if (strengths.length === 0) strengths.push("Current data does not show a standout financial edge.");
  if (risks.length === 0) risks.push("No obvious red flag from the limited snapshot, but this is still a partial screen.");

  return {
    valuation,
    style,
    strengths,
    risks,
  };
}

function classifyPeriodicReport(title: string): "annual" | "half-year" | "q1" | "q3" | "other" {
  if (title.includes("半年度报告")) return "half-year";
  if (title.includes("一季度报告")) return "q1";
  if (title.includes("三季度报告")) return "q3";
  if (title.includes("年度报告")) return "annual";
  return "other";
}

function chooseResolvedCandidate(
  rawQuery: string,
  candidates: StockLookupCandidate[],
): StockLookupCandidate | null {
  if (candidates.length === 1) return candidates[0];

  const query = rawQuery.trim().toLowerCase();
  const first = candidates[0];
  if (!first) return null;

  const normalizedCode = normalizeStockCode(query);
  const exactCode =
    normalizedCode &&
    candidates.find(
      (candidate) =>
        candidate.tsCode.toLowerCase() === normalizedCode.toLowerCase() ||
        candidate.symbol.toLowerCase() === normalizedCode.slice(0, 6).toLowerCase(),
    );
  if (exactCode) return exactCode;

  const exactName = candidates.find((candidate) => candidate.name.toLowerCase() === query);
  if (exactName) return exactName;

  return first.score - (candidates[1]?.score ?? 0) >= 20 ? first : null;
}

function rankLookupMatches(records: LookupRecord[], query: string): StockLookupCandidate[] {
  const lowerQuery = query.trim().toLowerCase();
  const normalizedCode = normalizeStockCode(query);
  const normalizedSymbol = normalizedCode?.slice(0, 6).toLowerCase();

  return records
    .map((record) => {
      let score = 0;
      let matchReason = "partial";

      if (normalizedCode && record.tsCode.toLowerCase() === normalizedCode.toLowerCase()) {
        score = 100;
        matchReason = "exact ts_code";
      } else if (normalizedSymbol && record.symbol.toLowerCase() === normalizedSymbol) {
        score = 95;
        matchReason = "exact symbol";
      } else if (record.name.toLowerCase() === lowerQuery) {
        score = 92;
        matchReason = "exact name";
      } else if (record.name.toLowerCase().startsWith(lowerQuery)) {
        score = 78;
        matchReason = "name prefix";
      } else if (record.name.toLowerCase().includes(lowerQuery)) {
        score = 64;
        matchReason = "name contains";
      } else if (record.symbol.toLowerCase().includes(lowerQuery)) {
        score = 60;
        matchReason = "symbol contains";
      } else if (record.tsCode.toLowerCase().includes(lowerQuery)) {
        score = 55;
        matchReason = "code contains";
      }

      return {
        tsCode: record.tsCode,
        symbol: record.symbol,
        name: record.name,
        market: record.market,
        industry: record.industry,
        area: record.area,
        listDate: record.listDate,
        quoteId: record.quoteId,
        orgId: record.orgId,
        score,
        matchReason,
      };
    })
    .filter((record) => record.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.tsCode.localeCompare(right.tsCode);
    });
}

function resolveCninfoMarketLabel(tsCode: string): string | undefined {
  const market = tsCode.slice(-2).toUpperCase();
  if (market === "SH") return "Shanghai";
  if (market === "SZ") return "Shenzhen";
  if (market === "BJ") return "Beijing";
  return undefined;
}

function formatCninfoDate(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function fetchLatestDailyBasic(
  client: TuShareClient,
  tsCode: string,
  tradeDate?: string,
): Promise<DailyBasicRecord> {
  const anchorDate = normalizeYmd(tradeDate) ?? formatShanghaiDate();
  const startDate = shiftYmd(anchorDate, -20);
  const rows = tradeDate
    ? await client.getDailyBasic({ tsCode, tradeDate: anchorDate })
    : await client.getDailyBasic({ tsCode, startDate, endDate: anchorDate });

  const latestTradeDate =
    tradeDate && rows.some((row) => row.tradeDate === anchorDate)
      ? anchorDate
      : pickLatestDate(rows, (row) => row.tradeDate);

  const latest = rows
    .filter((row) => row.tradeDate === latestTradeDate)
    .sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))[0];

  if (!latest) {
    throw new Error(`No daily_basic snapshot found for ${tsCode}.`);
  }
  return latest;
}

async function fetchLatestFinaIndicator(
  client: TuShareClient,
  tsCode: string,
): Promise<FinaIndicatorRecord | null> {
  const endDate = formatShanghaiDate();
  const startDate = shiftYmd(endDate, -500);
  const rows = await client.getFinaIndicator({ tsCode, startDate, endDate });
  if (rows.length === 0) return null;

  return [...rows].sort((left, right) => {
    const leftEndDate = left.endDate ?? "";
    const rightEndDate = right.endDate ?? "";
    if (rightEndDate !== leftEndDate) return rightEndDate.localeCompare(leftEndDate);
    return (right.annDate ?? "").localeCompare(left.annDate ?? "");
  })[0];
}

function normalizeStockCode(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return null;
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(trimmed)) return trimmed;
  if (!/^\d{6}$/.test(trimmed)) return null;

  const prefix = trimmed.slice(0, 3);
  if (["600", "601", "603", "605", "688", "689"].includes(prefix)) {
    return `${trimmed}.SH`;
  }
  if (["000", "001", "002", "003", "300", "301"].includes(prefix)) {
    return `${trimmed}.SZ`;
  }
  if (trimmed.startsWith("4") || trimmed.startsWith("8") || trimmed.startsWith("92")) {
    return `${trimmed}.BJ`;
  }
  return null;
}

function formatNullableNumber(value: number | null | undefined): string | null {
  if (value == null || Number.isNaN(value)) return null;
  return trimDecimals(value);
}

async function fetchEastmoneyLookupRecords(query: string, limit: number): Promise<LookupRecord[]> {
  const url = new URL(EASTMONEY_SEARCH_URL);
  url.searchParams.set("input", query);
  url.searchParams.set("type", "14");
  url.searchParams.set("token", EASTMONEY_SEARCH_TOKEN);
  url.searchParams.set("count", String(Math.max(1, limit)));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Public stock lookup failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    QuotationCodeTable?: {
      Data?: Array<{
        Code?: string;
        Name?: string;
        QuoteID?: string;
        SecurityTypeName?: string;
      }>;
    };
  };

  return (payload.QuotationCodeTable?.Data ?? [])
    .map((item) => {
      const symbol = String(item.Code ?? "").trim();
      const name = String(item.Name ?? "").trim();
      const quoteId = String(item.QuoteID ?? "").trim() || undefined;
      const tsCode = toTsCodeFromQuoteId(symbol, quoteId) ?? normalizeStockCode(symbol);

      if (!symbol || !name || !tsCode) return null;

      return {
        tsCode,
        symbol,
        name,
        market: resolveMarketLabel(tsCode, item.SecurityTypeName),
        quoteId,
      } satisfies LookupRecord;
    })
    .filter((record): record is LookupRecord => Boolean(record));
}

async function fetchCninfoLookupRecords(): Promise<LookupRecord[]> {
  const stockUniverse = await getCninfoStockUniverse();
  return stockUniverse
    .map((record) => {
      const tsCode = normalizeStockCode(record.code);
      if (!tsCode) return null;
      return {
        tsCode,
        symbol: record.code,
        name: record.shortName,
        market: resolveCninfoMarketLabel(tsCode),
        orgId: record.orgId,
      } satisfies LookupRecord;
    })
    .filter((record): record is LookupRecord => Boolean(record));
}

async function buildCninfoReferences(
  candidate: StockLookupCandidate,
  resolvedName: string,
): Promise<
  | {
      officialSource: "cninfo";
      companyProfileUrl?: string;
      periodicReports: Array<{
        title: string;
        publishedAt: string;
        pdfUrl?: string;
      }>;
      performanceDisclosures: Array<{
        title: string;
        publishedAt: string;
        pdfUrl?: string;
      }>;
    }
  | undefined
> {
  try {
    const [periodicReports, performanceDisclosures] = await Promise.all([
      fetchCninfoPeriodicReports({
        query: resolvedName,
        tsCode: candidate.tsCode,
        limit: 4,
      }),
      fetchCninfoPerformanceDisclosures({
        query: resolvedName,
        tsCode: candidate.tsCode,
        limit: 3,
      }),
    ]);
    return {
      officialSource: "cninfo",
      companyProfileUrl: buildCninfoCompanyProfileUrl(candidate.symbol),
      periodicReports: periodicReports.map((record) => ({
        title: record.announcementTitle,
        publishedAt: formatCninfoDate(record.announcementTime),
        pdfUrl: record.pdfUrl,
      })),
      performanceDisclosures: performanceDisclosures.map((record) => ({
        title: record.announcementTitle,
        publishedAt: formatCninfoDate(record.announcementTime),
        pdfUrl: record.pdfUrl,
      })),
    };
  } catch {
    return {
      officialSource: "cninfo",
      companyProfileUrl: buildCninfoCompanyProfileUrl(candidate.symbol),
      periodicReports: [],
      performanceDisclosures: [],
    };
  }
}

async function fetchPublicQuote(candidate: StockLookupCandidate): Promise<{
  totalMarketValue: number | null;
  floatMarketValue: number | null;
  industry: string | null;
  peTtmRaw: number | null;
  pbRaw: number | null;
  turnoverRateRaw: number | null;
  roePct: number | null;
  netProfitMarginPct: number | null;
  debtToAssetsPct: number | null;
}> {
  const quoteId = candidate.quoteId ?? toQuoteIdFromTsCode(candidate.tsCode);
  if (!quoteId) {
    throw new Error(`Public quote snapshot could not resolve a quote id for ${candidate.tsCode}.`);
  }

  const url = new URL(EASTMONEY_QUOTE_URL);
  url.searchParams.set("secid", quoteId);
  url.searchParams.set(
    "fields",
    "f57,f58,f116,f117,f127,f162,f167,f168,f173,f187,f188",
  );

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Public quote request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    data?: {
      f116?: unknown;
      f117?: unknown;
      f127?: unknown;
      f162?: unknown;
      f167?: unknown;
      f168?: unknown;
      f173?: unknown;
      f187?: unknown;
      f188?: unknown;
    };
  };

  const data = payload.data;
  if (!data) {
    throw new Error(`Public quote snapshot was empty for ${candidate.tsCode}.`);
  }

  return {
    totalMarketValue: toNullableNumber(data.f116),
    floatMarketValue: toNullableNumber(data.f117),
    industry: toOptionalString(data.f127) ?? null,
    peTtmRaw: toNullableNumber(data.f162),
    pbRaw: toNullableNumber(data.f167),
    turnoverRateRaw: toNullableNumber(data.f168),
    roePct: toNullableNumber(data.f173),
    netProfitMarginPct: toNullableNumber(data.f187),
    debtToAssetsPct: toNullableNumber(data.f188),
  };
}

function toTsCodeFromQuoteId(symbol: string, quoteId?: string): string | null {
  if (!symbol) return null;
  if (quoteId?.startsWith("1.")) return `${symbol}.SH`;
  if (quoteId?.startsWith("0.")) {
    const normalized = normalizeStockCode(symbol);
    return normalized ?? `${symbol}.SZ`;
  }
  return normalizeStockCode(symbol);
}

function toQuoteIdFromTsCode(tsCode?: string): string | undefined {
  const normalized = tsCode?.trim().toUpperCase();
  if (!normalized) return undefined;
  const [symbol, market] = normalized.split(".");
  if (!symbol || !market) return undefined;
  if (market === "SH") return `1.${symbol}`;
  if (market === "SZ" || market === "BJ") return `0.${symbol}`;
  return undefined;
}

function resolveMarketLabel(tsCode: string, securityTypeName?: string): string | undefined {
  const label = securityTypeName?.trim();
  if (label) return label;
  if (tsCode.endsWith(".SH")) return "Shanghai A";
  if (tsCode.endsWith(".SZ")) return "Shenzhen A";
  if (tsCode.endsWith(".BJ")) return "Beijing A";
  return undefined;
}

function scaleEastmoneyPercentHundred(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  return Number(trimDecimals(value / 100));
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function toOptionalString(value: unknown): string | undefined {
  const result = String(value ?? "").trim();
  return result ? result : undefined;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
