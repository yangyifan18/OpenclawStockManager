import { emptyPluginConfigSchema, jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  buildAuctionHotspotReport,
  buildDisclosureAnalysisReport,
  buildFundamentalsReport,
  buildPublicFundamentalsReport,
  lookupStocks,
  lookupStocksPublic,
} from "./src/analysis.js";
import { isMissingTuShareTokenError, resolveTuShareClient } from "./src/tushare.js";

const STOCK_LOOKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "A-share stock code or stock name, for example 600519 or Ningde Times.",
    },
    limit: {
      type: "number",
      description: "Maximum number of candidates to return.",
    },
  },
  required: ["query"],
};

const STOCK_FUNDAMENTALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "A-share stock code or stock name.",
    },
    tradeDate: {
      type: "string",
      description: "Optional YYYYMMDD trade date anchor. Falls back to the latest available snapshot.",
    },
  },
  required: ["query"],
};

const STOCK_AUCTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tradeDate: {
      type: "string",
      description: "Optional YYYYMMDD trade date. Defaults to the latest available auction snapshot.",
    },
    topN: {
      type: "number",
      description: "Number of leader stocks to keep.",
    },
    minVolumeRatio: {
      type: "number",
      description: "Minimum volume ratio filter.",
    },
    minTurnoverRatePct: {
      type: "number",
      description: "Minimum turnover rate percentage filter.",
    },
    minAuctionChangePct: {
      type: "number",
      description: "Minimum auction change percentage filter.",
    },
  },
};

const STOCK_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "A-share stock code or stock name.",
    },
  },
  required: ["query"],
};

const plugin = {
  id: "stock-tools",
  name: "Stock Tools",
  description: "A-share stock lookup, fundamentals, and auction hotspot tools for OpenClaw.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const buildClient = async () =>
          resolveTuShareClient({
            workspaceDir: ctx.workspaceDir,
            globalStateDir: api.resolvePath("~/.openclaw"),
          });
        const buildClientOptional = async () => {
          try {
            const resolved = await buildClient();
            return { ...resolved, tokenMissing: false };
          } catch (error) {
            if (isMissingTuShareTokenError(error)) {
              return { client: null, envSources: [], tokenMissing: true } as const;
            }
            throw error;
          }
        };

        return [
          {
            name: "stock_lookup",
            label: "A-share Stock Lookup",
            description:
              "Resolve a Chinese A-share stock name or code to one or more matching tickers.",
            parameters: STOCK_LOOKUP_SCHEMA,
            async execute(_id: string, params: Record<string, unknown>) {
              const query = typeof params.query === "string" ? params.query.trim() : "";
              const limit = typeof params.limit === "number" ? params.limit : 5;
              if (!query) {
                throw new Error("query is required");
              }

              const { client, envSources, tokenMissing } = await buildClientOptional();
              const matches = client
                ? await lookupStocks(client, query, limit)
                : await lookupStocksPublic(query, limit);
              return jsonResult({
                ok: true,
                query,
                envSources,
                source: client ? "tushare" : "public_quote",
                tokenMissing,
                count: matches.length,
                matches,
              });
            },
          },
          {
            name: "stock_fundamentals",
            label: "A-share Fundamentals",
            description:
              "Fetch a Chinese A-share stock fundamentals snapshot by stock code or company name.",
            parameters: STOCK_FUNDAMENTALS_SCHEMA,
            async execute(_id: string, params: Record<string, unknown>) {
              const query = typeof params.query === "string" ? params.query.trim() : "";
              const tradeDate = typeof params.tradeDate === "string" ? params.tradeDate.trim() : undefined;
              if (!query) {
                throw new Error("query is required");
              }

              const { client, envSources, tokenMissing } = await buildClientOptional();
              const report = client
                ? await buildFundamentalsReport(client, query, tradeDate)
                : await buildPublicFundamentalsReport(query);
              return jsonResult({
                ...report,
                envSources,
                tokenMissing,
              });
            },
          },
          {
            name: "stock_auction_hotspots",
            label: "A-share Auction Hotspots",
            description:
              "Analyze opening auction leaders, sector heat, and capital-style bias for Chinese A-shares.",
            parameters: STOCK_AUCTION_SCHEMA,
            async execute(_id: string, params: Record<string, unknown>) {
              const { client, envSources } = await buildClient();
              const report = await buildAuctionHotspotReport(client, {
                tradeDate: typeof params.tradeDate === "string" ? params.tradeDate.trim() : undefined,
                topN: typeof params.topN === "number" ? params.topN : undefined,
                minVolumeRatio:
                  typeof params.minVolumeRatio === "number" ? params.minVolumeRatio : undefined,
                minTurnoverRatePct:
                  typeof params.minTurnoverRatePct === "number"
                    ? params.minTurnoverRatePct
                    : undefined,
                minAuctionChangePct:
                  typeof params.minAuctionChangePct === "number"
                    ? params.minAuctionChangePct
                    : undefined,
              });

              return jsonResult({
                ...report,
                envSources,
              });
            },
          },
          {
            name: "stock_reports",
            label: "A-share Reports & Earnings Disclosures",
            description:
              "Fetch official CNINFO periodic reports and earnings-related disclosures for a Chinese A-share stock.",
            parameters: STOCK_REPORT_SCHEMA,
            async execute(_id: string, params: Record<string, unknown>) {
              const query = typeof params.query === "string" ? params.query.trim() : "";
              if (!query) {
                throw new Error("query is required");
              }

              const report = await buildDisclosureAnalysisReport(query);
              return jsonResult(report);
            },
          },
        ];
      },
      { names: ["stock_lookup", "stock_fundamentals", "stock_auction_hotspots", "stock_reports"] },
    );

    api.registerCommand({
      name: "stock-fund",
      description: "Quick fundamentals snapshot for a stock code or name",
      acceptsArgs: true,
      handler: async (ctx) => {
        const query = ctx.args?.trim();
        if (!query) {
          return {
            text: "Usage: /stock-fund <stock name or code>",
          };
        }

        try {
          let report:
            | Awaited<ReturnType<typeof buildFundamentalsReport>>
            | Awaited<ReturnType<typeof buildPublicFundamentalsReport>>;
          try {
            const { client } = await resolveTuShareClient({
              workspaceDir: api.config?.agents?.defaults?.workspace,
              globalStateDir: api.resolvePath("~/.openclaw"),
            });
            report = await buildFundamentalsReport(client, query);
          } catch (error) {
            if (!isMissingTuShareTokenError(error)) throw error;
            report = await buildPublicFundamentalsReport(query);
          }
          return {
            text: formatFundamentalsCommandReply(report),
          };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });

    api.registerCommand({
      name: "stock-auction",
      description: "Quick auction hotspot summary for the latest or specified trade date",
      acceptsArgs: true,
      handler: async (ctx) => {
        const tradeDate = ctx.args?.trim() || undefined;
        try {
          const { client } = await resolveTuShareClient({
            workspaceDir: api.config?.agents?.defaults?.workspace,
            globalStateDir: api.resolvePath("~/.openclaw"),
          });
          const report = await buildAuctionHotspotReport(client, {
            tradeDate,
          });
          return {
            text: formatAuctionCommandReply(report),
          };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });

    api.registerCommand({
      name: "stock-report",
      description: "Official CNINFO report and earnings-disclosure summary for a stock code or name",
      acceptsArgs: true,
      handler: async (ctx) => {
        const query = ctx.args?.trim();
        if (!query) {
          return {
            text: "Usage: /stock-report <stock name or code>",
          };
        }

        try {
          const report = await buildDisclosureAnalysisReport(query);
          return {
            text: formatDisclosureCommandReply(report),
          };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  },
};

export default plugin;

function formatFundamentalsCommandReply(
  report: Awaited<ReturnType<typeof buildFundamentalsReport>> | Awaited<ReturnType<typeof buildPublicFundamentalsReport>>,
): string {
  if (!report.ok) {
    if (report.candidates && report.candidates.length > 0) {
      const choices = report.candidates
        .map((candidate) => `${candidate.name} (${candidate.symbol}, ${candidate.tsCode})`)
        .join("; ");
      return `${report.message}\nCandidates: ${choices}`;
    }
    return report.message;
  }

  const lines = [
    `${report.resolved.name} ${report.resolved.tsCode}`,
    `Industry: ${report.resolved.industry ?? "n/a"}`,
    `Source: ${report.source === "tushare" ? "TuShare" : "Public quote fallback"}${report.coverage === "basic" ? " (limited metrics)" : ""}`,
    `PE(TTM): ${report.formatted.peTtm ?? "n/a"}  PB: ${report.formatted.pb ?? "n/a"}`,
    `ROE: ${report.formatted.roe ?? "n/a"}  Debt/Assets: ${report.formatted.debtToAssets ?? "n/a"}`,
    `Revenue YoY: ${report.formatted.revenueYoy ?? "n/a"}  Net Profit YoY: ${report.formatted.netProfitYoy ?? "n/a"}`,
    `Take: ${report.quickTake.valuation} ${report.quickTake.style}`,
    `Data: daily=${report.dataTime.fundamentalsTradeDate}${report.dataTime.financialReportEndDate ? ` report=${report.dataTime.financialReportEndDate}` : ""}`,
  ];

  if (report.references?.companyProfileUrl) {
    lines.push(`CNINFO: ${report.references.companyProfileUrl}`);
  }
  if (report.references?.periodicReports?.[0]) {
    const latestReport = report.references.periodicReports[0];
    lines.push(`Latest report: ${latestReport.title} (${latestReport.publishedAt})${latestReport.pdfUrl ? ` ${latestReport.pdfUrl}` : ""}`);
  }
  if (report.references?.performanceDisclosures?.[0]) {
    const latestDisclosure = report.references.performanceDisclosures[0];
    lines.push(`Latest earnings notice: ${latestDisclosure.title} (${latestDisclosure.publishedAt})${latestDisclosure.pdfUrl ? ` ${latestDisclosure.pdfUrl}` : ""}`);
  }

  return lines.join("\n");
}

function formatDisclosureCommandReply(
  report: Awaited<ReturnType<typeof buildDisclosureAnalysisReport>>,
): string {
  if (!report.ok) {
    if (report.candidates && report.candidates.length > 0) {
      const choices = report.candidates
        .map((candidate) => `${candidate.name} (${candidate.symbol}, ${candidate.tsCode})`)
        .join("; ");
      return `${report.message}\nCandidates: ${choices}`;
    }
    return report.message;
  }

  const lines = [
    `${report.resolved.name} ${report.resolved.tsCode}`,
    `CNINFO: ${report.companyProfileUrl}`,
    `Rhythm: ${report.analysis.disclosureRhythm}`,
  ];

  if (report.analysis.latestPeriodicReport) {
    lines.push(`Latest periodic: ${report.analysis.latestPeriodicReport}`);
  }
  if (report.analysis.latestPerformanceDisclosure) {
    lines.push(`Latest earnings notice: ${report.analysis.latestPerformanceDisclosure}`);
  }

  if (report.periodicReports.length > 0) {
    lines.push(
      `Recent reports: ${report.periodicReports
        .slice(0, 3)
        .map((item) => `${item.title} (${item.publishedAt})`)
        .join("; ")}`,
    );
  }

  if (report.performanceDisclosures.length > 0) {
    lines.push(
      `Earnings disclosures: ${report.performanceDisclosures
        .slice(0, 2)
        .map((item) => `${item.title} (${item.publishedAt})`)
        .join("; ")}`,
    );
  }

  if (report.analysis.focus.length > 0) {
    lines.push(`Focus: ${report.analysis.focus[0]}`);
  }
  if (report.analysis.risks.length > 0) {
    lines.push(`Risk: ${report.analysis.risks[0]}`);
  }

  return lines.join("\n");
}

function formatAuctionCommandReply(
  report: Awaited<ReturnType<typeof buildAuctionHotspotReport>>,
): string {
  const sectorText =
    report.sectors.length > 0
      ? report.sectors
          .slice(0, 3)
          .map(
            (sector, index) =>
              `${index + 1}. ${sector.industry} | count=${sector.stockCount} | avgGap=${sector.avgAuctionChangePct}% | leaders=${sector.leaders.join(", ")}`,
          )
          .join("\n")
      : "No sector clusters passed the current filter.";

  const flow = report.capitalFlowInference;
  const lines = [
    `Auction date: ${report.tradeDate}${report.usedLatestAvailable ? " (latest available)" : ""}`,
    `Risk appetite: ${flow.riskAppetite}, concentration: ${flow.concentration}, style: ${flow.dominantStyle}`,
    sectorText,
  ];
  return lines.join("\n");
}
