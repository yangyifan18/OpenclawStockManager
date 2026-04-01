const CNINFO_STOCK_LIST_URL = "https://www.cninfo.com.cn/new/data/szse_stock.json";
const CNINFO_DISCLOSURE_QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const CNINFO_REFERER = "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search";
const CNINFO_PERIODIC_CATEGORY =
  "category_ndbg_szsh;category_bndbg_szsh;category_yjdbg_szsh;category_sjdbg_szsh";
const CNINFO_CACHE_TTL_MS = 30 * 60 * 1000;
const CNINFO_DEFAULT_DATE_RANGE = "2023-01-01~2026-12-31";

export type CninfoStockRecord = {
  code: string;
  orgId?: string;
  shortName: string;
  pinyin?: string;
  category?: string;
};

export type CninfoAnnouncementRecord = {
  secCode: string;
  secName: string;
  orgId?: string;
  announcementId?: string;
  announcementTitle: string;
  announcementTime: number;
  adjunctUrl?: string;
  pdfUrl?: string;
};

let stockUniverseCache:
  | {
      expiresAt: number;
      records: CninfoStockRecord[];
    }
  | undefined;

export async function getCninfoStockUniverse(): Promise<CninfoStockRecord[]> {
  if (stockUniverseCache && stockUniverseCache.expiresAt > Date.now()) {
    return stockUniverseCache.records;
  }

  const response = await fetch(CNINFO_STOCK_LIST_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.cninfo.com.cn/new/index",
    },
  });
  if (!response.ok) {
    throw new Error(`CNINFO stock list request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    stockList?: Array<{
      code?: string;
      orgId?: string;
      zwjc?: string;
      pinyin?: string;
      category?: string;
    }>;
  };

  const records = (payload.stockList ?? [])
    .map((item) => {
      const code = String(item.code ?? "").trim();
      const shortName = String(item.zwjc ?? "").trim();
      if (!code || !shortName) return null;
      return {
        code,
        shortName,
        orgId: optionalString(item.orgId),
        pinyin: optionalString(item.pinyin),
        category: optionalString(item.category),
      };
    })
    .filter((item): item is CninfoStockRecord => Boolean(item));

  stockUniverseCache = {
    expiresAt: Date.now() + CNINFO_CACHE_TTL_MS,
    records,
  };
  return records;
}

export async function fetchCninfoPeriodicReports(params: {
  query: string;
  tsCode?: string;
  limit?: number;
}): Promise<CninfoAnnouncementRecord[]> {
  const announcements = await fetchCninfoAnnouncements({
    query: params.query,
    tsCode: params.tsCode,
    category: CNINFO_PERIODIC_CATEGORY,
    limit: params.limit ?? 12,
  });

  return dedupePeriodicReports(announcements).slice(0, params.limit ?? 4);
}

export async function fetchCninfoPerformanceDisclosures(params: {
  query: string;
  tsCode?: string;
  limit?: number;
}): Promise<CninfoAnnouncementRecord[]> {
  const announcements = await fetchCninfoAnnouncements({
    query: params.query,
    tsCode: params.tsCode,
    limit: Math.max(params.limit ?? 10, 12),
  });

  return announcements
    .filter((item) => isPerformanceDisclosureTitle(item.announcementTitle))
    .slice(0, params.limit ?? 4);
}

export async function fetchCninfoAnnouncements(params: {
  query: string;
  tsCode?: string;
  category?: string;
  limit?: number;
  dateRange?: string;
}): Promise<CninfoAnnouncementRecord[]> {
  const symbol = params.tsCode?.slice(0, 6);
  const plate = inferPlate(params.tsCode);
  const form = new URLSearchParams({
    pageNum: "1",
    pageSize: String(Math.max(1, params.limit ?? 12)),
    column: inferColumn(params.tsCode),
    tabName: "fulltext",
    plate,
    stock: "",
    searchkey: symbol || params.query.trim(),
    secid: "",
    category: params.category ?? "",
    trade: "",
    seDate: params.dateRange ?? CNINFO_DEFAULT_DATE_RANGE,
    sortName: "",
    sortType: "",
    isHLtitle: "true",
  });

  const response = await fetch(CNINFO_DISCLOSURE_QUERY_URL, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: CNINFO_REFERER,
    },
    body: form.toString(),
  });

  if (!response.ok) {
    throw new Error(`CNINFO disclosure query failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    announcements?: Array<{
      secCode?: string;
      secName?: string;
      orgId?: string;
      announcementId?: string;
      announcementTitle?: string;
      announcementTime?: number;
      adjunctUrl?: string;
    }>;
  };

  const announcements = (payload.announcements ?? [])
    .map((item) => {
      const secCode = String(item.secCode ?? "").trim();
      const announcementTitle = stripHtml(String(item.announcementTitle ?? "").trim());
      if (!secCode || !announcementTitle) return null;

      const adjunctUrl = optionalString(item.adjunctUrl);
      return {
        secCode,
        secName: stripHtml(String(item.secName ?? "").trim()),
        orgId: optionalString(item.orgId),
        announcementId: optionalString(item.announcementId),
        announcementTitle,
        announcementTime: Number(item.announcementTime ?? 0) || 0,
        adjunctUrl,
        pdfUrl: adjunctUrl ? toAbsolutePdfUrl(adjunctUrl) : undefined,
      } satisfies CninfoAnnouncementRecord;
    })
    .filter((item): item is CninfoAnnouncementRecord => Boolean(item))
    .filter((item) => !symbol || item.secCode === symbol)
    .sort((left, right) => right.announcementTime - left.announcementTime);

  return announcements;
}

export function buildCninfoCompanyProfileUrl(symbol: string): string {
  return `https://www.cninfo.com.cn/new/snapshot/companyDetailCn?code=${encodeURIComponent(symbol)}`;
}

function inferColumn(tsCode?: string): string {
  if (!tsCode) return "szse";
  const market = tsCode.slice(-2).toUpperCase();
  if (market === "SH") return "sse";
  if (market === "BJ") return "third";
  return "szse";
}

function inferPlate(tsCode?: string): string {
  if (!tsCode) return "";
  const symbol = tsCode.slice(0, 6);
  const market = tsCode.slice(-2).toUpperCase();
  if (market === "SH") {
    return symbol.startsWith("688") ? "shkcp" : "sh";
  }
  if (market === "BJ") return "bj";
  if (symbol.startsWith("300") || symbol.startsWith("301")) return "szcy";
  return "sz";
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

function optionalString(value: unknown): string | undefined {
  const stringValue = String(value ?? "").trim();
  return stringValue || undefined;
}

function toAbsolutePdfUrl(adjunctUrl: string): string {
  const normalized = adjunctUrl.replace(/^\/+/, "");
  return `https://www.cninfo.com.cn/${normalized}`;
}

function dedupePeriodicReports(records: CninfoAnnouncementRecord[]): CninfoAnnouncementRecord[] {
  const preferred = [...records].sort((left, right) => {
    const timeDelta = right.announcementTime - left.announcementTime;
    if (timeDelta !== 0) return timeDelta;
    return reportPenalty(left.announcementTitle) - reportPenalty(right.announcementTitle);
  });

  const seen = new Set<string>();
  const deduped: CninfoAnnouncementRecord[] = [];

  for (const record of preferred) {
    const baseTitle = record.announcementTitle.replace(/摘要/g, "").trim();
    const key = `${record.secCode}:${baseTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }

  return deduped;
}

function reportPenalty(title: string): number {
  if (title.includes("摘要")) return 10;
  return 0;
}

function isPerformanceDisclosureTitle(title: string): boolean {
  return /(业绩预告|业绩快报|预增|预减|预亏|扭亏|续盈|略增|略减)/.test(title);
}
