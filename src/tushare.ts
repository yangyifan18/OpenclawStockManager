import fs from "node:fs/promises";
import path from "node:path";

export type StockBasicRecord = {
  tsCode: string;
  symbol: string;
  name: string;
  area?: string;
  industry?: string;
  market?: string;
  listDate?: string;
};

export type DailyBasicRecord = {
  tsCode: string;
  tradeDate: string;
  peTtm: number | null;
  pb: number | null;
  turnoverRatePct: number | null;
  volumeRatio: number | null;
  totalMvWan: number | null;
  circMvWan: number | null;
};

export type FinaIndicatorRecord = {
  tsCode: string;
  annDate?: string;
  endDate?: string;
  roePct: number | null;
  grossMarginPct: number | null;
  netProfitMarginPct: number | null;
  debtToAssetsPct: number | null;
  revenueYoyPct: number | null;
  netProfitYoyPct: number | null;
};

export type AuctionRecord = {
  tsCode: string;
  tradeDate: string;
  vol: number;
  price: number;
  amount: number;
  preClose: number;
  turnoverRatePct: number | null;
  volumeRatio: number | null;
  floatShareWan: number | null;
};

type TuShareResponse = {
  code: number;
  msg: string;
  data?: {
    fields?: string[];
    items?: unknown[][];
  };
};

type RequestParams = Record<string, string | number | undefined>;

const DEFAULT_TUSHARE_API_URL = "http://api.tushare.pro";
const DEFAULT_ENV_FILE_NAME = "stock-tools.env";
const STOCK_CACHE_TTL_MS = 30 * 60 * 1000;

let stockUniverseCache:
  | {
      expiresAt: number;
      records: StockBasicRecord[];
    }
  | undefined;

export class TuShareClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(params: { token: string; baseUrl?: string }) {
    const token = params.token.trim();
    if (!token) {
      throw new Error("Missing TuShare token.");
    }
    this.token = token;
    this.baseUrl = params.baseUrl?.trim() || DEFAULT_TUSHARE_API_URL;
  }

  private async request(apiName: string, params: RequestParams, fields: string): Promise<unknown[][]> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_name: apiName,
        token: this.token,
        params,
        fields,
      }),
    });

    if (!response.ok) {
      throw new Error(`TuShare request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as TuShareResponse;
    if (payload.code !== 0) {
      throw new Error(payload.msg || `TuShare API error: ${payload.code}`);
    }

    return Array.isArray(payload.data?.items) ? payload.data.items : [];
  }

  async getStockBasic(params: {
    tsCode?: string;
    symbol?: string;
    name?: string;
    listStatus?: string;
  } = {}): Promise<StockBasicRecord[]> {
    const rows = await this.request(
      "stock_basic",
      {
        ts_code: params.tsCode,
        symbol: params.symbol,
        name: params.name,
        list_status: params.listStatus,
      },
      "ts_code,symbol,name,area,industry,market,list_date",
    );

    return rows.map((row) => ({
      tsCode: toStringValue(row[0]),
      symbol: toStringValue(row[1]),
      name: toStringValue(row[2]),
      area: optionalStringValue(row[3]),
      industry: optionalStringValue(row[4]),
      market: optionalStringValue(row[5]),
      listDate: optionalStringValue(row[6]),
    }));
  }

  async getDailyBasic(params: {
    tsCode?: string;
    tradeDate?: string;
    startDate?: string;
    endDate?: string;
  } = {}): Promise<DailyBasicRecord[]> {
    const rows = await this.request(
      "daily_basic",
      {
        ts_code: params.tsCode,
        trade_date: params.tradeDate,
        start_date: params.startDate,
        end_date: params.endDate,
      },
      "ts_code,trade_date,pe_ttm,pb,turnover_rate,volume_ratio,total_mv,circ_mv",
    );

    return rows.map((row) => ({
      tsCode: toStringValue(row[0]),
      tradeDate: toStringValue(row[1]),
      peTtm: nullableNumberValue(row[2]),
      pb: nullableNumberValue(row[3]),
      turnoverRatePct: nullableNumberValue(row[4]),
      volumeRatio: nullableNumberValue(row[5]),
      totalMvWan: nullableNumberValue(row[6]),
      circMvWan: nullableNumberValue(row[7]),
    }));
  }

  async getFinaIndicator(params: {
    tsCode: string;
    startDate?: string;
    endDate?: string;
  }): Promise<FinaIndicatorRecord[]> {
    const rows = await this.request(
      "fina_indicator",
      {
        ts_code: params.tsCode,
        start_date: params.startDate,
        end_date: params.endDate,
      },
      "ts_code,ann_date,end_date,roe,grossprofit_margin,netprofit_margin,debt_to_assets,q_sales_yoy,q_dtprofit_yoy",
    );

    return rows.map((row) => ({
      tsCode: toStringValue(row[0]),
      annDate: optionalStringValue(row[1]),
      endDate: optionalStringValue(row[2]),
      roePct: nullableNumberValue(row[3]),
      grossMarginPct: nullableNumberValue(row[4]),
      netProfitMarginPct: nullableNumberValue(row[5]),
      debtToAssetsPct: nullableNumberValue(row[6]),
      revenueYoyPct: nullableNumberValue(row[7]),
      netProfitYoyPct: nullableNumberValue(row[8]),
    }));
  }

  async getAuction(params: {
    tsCode?: string;
    tradeDate?: string;
    startDate?: string;
    endDate?: string;
  } = {}): Promise<AuctionRecord[]> {
    const rows = await this.request(
      "stk_auction",
      {
        ts_code: params.tsCode,
        trade_date: params.tradeDate,
        start_date: params.startDate,
        end_date: params.endDate,
      },
      "ts_code,trade_date,vol,price,amount,pre_close,turnover_rate,volume_ratio,float_share",
    );

    return rows.map((row) => ({
      tsCode: toStringValue(row[0]),
      tradeDate: toStringValue(row[1]),
      vol: numberValue(row[2]),
      price: numberValue(row[3]),
      amount: numberValue(row[4]),
      preClose: numberValue(row[5]),
      turnoverRatePct: nullableNumberValue(row[6]),
      volumeRatio: nullableNumberValue(row[7]),
      floatShareWan: nullableNumberValue(row[8]),
    }));
  }
}

export async function resolveTuShareClient(params: {
  workspaceDir?: string;
  globalStateDir?: string;
}): Promise<{ client: TuShareClient; envSources: string[] }> {
  const envSources: string[] = [];
  const envVars = await readEnvCandidates(params);
  const token =
    process.env.TUSHARE_TOKEN?.trim() ||
    envVars.TUSHARE_TOKEN?.trim() ||
    "";

  if (process.env.TUSHARE_TOKEN?.trim()) {
    envSources.push("env:TUSHARE_TOKEN");
  }
  if (!process.env.TUSHARE_TOKEN?.trim() && envVars.TUSHARE_TOKEN?.trim()) {
    envSources.push(...envVars.__sources);
  }

  if (!token) {
    const searched = envVars.__searched.length > 0 ? envVars.__searched.join(", ") : "(none)";
    throw new Error(
      `Missing TuShare token. Set TUSHARE_TOKEN or write it into ${DEFAULT_ENV_FILE_NAME}. Searched: ${searched}`,
    );
  }

  const baseUrl =
    process.env.TUSHARE_BASE_URL?.trim() ||
    envVars.TUSHARE_BASE_URL?.trim() ||
    DEFAULT_TUSHARE_API_URL;

  return {
    client: new TuShareClient({ token, baseUrl }),
    envSources,
  };
}

export function isMissingTuShareTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Missing TuShare token");
}

export async function getStockUniverse(client: TuShareClient): Promise<StockBasicRecord[]> {
  if (stockUniverseCache && stockUniverseCache.expiresAt > Date.now()) {
    return stockUniverseCache.records;
  }

  const records = await client.getStockBasic({ listStatus: "L" });
  stockUniverseCache = {
    expiresAt: Date.now() + STOCK_CACHE_TTL_MS,
    records,
  };
  return records;
}

export function formatShanghaiDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return formatDateInZone(date, "Asia/Shanghai");
}

export function shiftYmd(ymd: string, deltaDays: number): string {
  const normalized = normalizeYmd(ymd);
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6)) - 1;
  const day = Number(normalized.slice(6, 8));
  const date = new Date(Date.UTC(year, month, day + deltaDays));
  return formatDateInZone(date, "UTC");
}

export function normalizeYmd(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/-/g, "");
  return /^\d{8}$/.test(digits) ? digits : undefined;
}

export function pickLatestDate<T>(records: T[], getDate: (record: T) => string | undefined): string | undefined {
  const values = records
    .map((record) => getDate(record))
    .filter((value): value is string => Boolean(value))
    .sort();
  return values.length > 0 ? values[values.length - 1] : undefined;
}

export function formatWan(value: number | null | undefined): string | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value >= 100_000_000) return `${trimDecimals(value / 100_000_000)}万亿`;
  if (value >= 10_000) return `${trimDecimals(value / 10_000)}亿`;
  return `${trimDecimals(value)}万`;
}

export function formatPercent(value: number | null | undefined): string | null {
  if (value == null || Number.isNaN(value)) return null;
  return `${trimDecimals(value)}%`;
}

export function trimDecimals(value: number, fractionDigits = 2): string {
  return value.toFixed(fractionDigits).replace(/\.?0+$/, "");
}

function formatDateInZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}${month}${day}`;
}

async function readEnvCandidates(params: {
  workspaceDir?: string;
  globalStateDir?: string;
}): Promise<Record<string, string> & { __sources: string[]; __searched: string[] }> {
  const searched: string[] = [];
  const sources: string[] = [];
  const merged: Record<string, string> = {};

  const candidates = [
    params.workspaceDir ? path.join(params.workspaceDir, `.${DEFAULT_ENV_FILE_NAME}`) : undefined,
    params.workspaceDir ? path.join(params.workspaceDir, DEFAULT_ENV_FILE_NAME) : undefined,
    params.globalStateDir ? path.join(params.globalStateDir, DEFAULT_ENV_FILE_NAME) : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    searched.push(candidate);
    try {
      const text = await fs.readFile(candidate, "utf8");
      const parsed = parseEnvText(text);
      for (const [key, value] of Object.entries(parsed)) {
        if (!merged[key]) {
          merged[key] = value;
          sources.push(candidate);
        }
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  return {
    ...merged,
    __sources: [...new Set(sources)],
    __searched: searched,
  };
}

function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    result[key] = stripQuotes(rawValue);
  }
  return result;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function toStringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function optionalStringValue(value: unknown): string | undefined {
  const result = toStringValue(value);
  return result ? result : undefined;
}

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
