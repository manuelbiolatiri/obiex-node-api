import { removeEmptyValue, buildQueryString } from "./utils";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { createHmac } from "crypto";
import { CacheService } from "./cache";
import { ServerError } from "./errors/server";
import {
  Currency,
  Network,
  Options,
  Quote,
  Response,
  TradePair,
  BankAccountPayout,
  CryptoAccountPayout,
  TransactionCategory,
} from "./types";

export class ObiexClient {
  private client: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  private cacheService: CacheService;

  constructor({ apiKey, apiSecret, sandboxMode = false }: Options) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    const baseURL = sandboxMode
      ? "https://staging.api.obiex.finance"
      : "https://api.obiex.finance";

    this.client = axios.create({ baseURL });

    this.client.interceptors.request.use((c) => this.requestConfig(c));
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response && error.response.data) {
          return Promise.reject(
            new ServerError(
              error.response.message,
              error.response.data,
              error.response.status
            )
          );
        }

        return Promise.reject(error);
      }
    );

    this.cacheService = new CacheService();
  }

  private requestConfig(requestConfig: AxiosRequestConfig) {
    let url = requestConfig.url,
      params = requestConfig.params;

    params = removeEmptyValue(params);
    params = buildQueryString(params);

    if (params !== "") {
      url = `${url}?${params}`;
    }

    const { timestamp, signature } = this.sign(requestConfig.method, url);

    requestConfig.headers["x-api-timestamp"] = timestamp;
    requestConfig.headers["x-api-signature"] = signature;
    requestConfig.headers["x-api-key"] = this.apiKey;

    return requestConfig;
  }

  private sign(method: string, originalUrl: string) {
    const timestamp = Date.now();

    const content = `${method.toUpperCase()}${originalUrl}${timestamp}`;

    const signature = createHmac("sha256", this.apiSecret)
      .update(content)
      .digest("hex");

    return {
      timestamp,
      signature,
    };
  }

  /**
   * Generate a deposit address for a currency. Re-using the same identifier always returns the same address
   * @param currency The currency code eg. BTC, USDT
   * @param identifier A unique identifier you can tie to your users.
   */
  async getDepositAddress(
    currency: string,
    network: string,
    identifier: string
  ) {
    const { data: response } = await this.client.post(`/v1/addresses/broker`, {
      currency,
      network,
      purpose: identifier,
    });

    const { data } = response;

    return {
      address: data.value,
      memo: data.memo,
      network: data.network,
      identifier: data.purpose,
    };
  }

  async getTradePairs() {
    const { data: response } = await this.client.get<Response<TradePair[]>>(
      "/v1/trades/pairs"
    );

    return response.data.map((x) => ({
      id: x.id,
      source: x.source.code,
      target: x.target.code,
      isBuyable: x.isBuyable,
      isSellable: x.isSellable,
    }));
  }

  async getTradePairsByCurrency(currencyId: string) {
    const { data: response } = await this.client.get<Response<TradePair[]>>(
      `/v1/currencies/${currencyId}/pairs`
    );

    return response.data.map((x) => ({
      id: x.id,
      source: x.source.code,
      target: x.target.code,
      isBuyable: x.isBuyable,
      isSellable: x.isSellable,
    }));
  }

  /**
   * Create quote for trade
   * @param source Left hand side for pair i.e. BTC in BTC/USDT
   * @param target Right hand side for trade pair i.e. USDT in BTC/USDT
   * @param side The trade side i.e. BUY: USDT -> BTC & SELL: BTC -> USDT for BTC/USDT
   * @param amount The amount you intend to trade
   * @returns
   */
  async createQuote(
    source: string,
    target: string,
    side: "BUY" | "SELL",
    amount: number
  ) {
    const sourceCurrency = await this.getCurrencyByCode(source);
    const targetCurrency = await this.getCurrencyByCode(target);

    const { data: response } = await this.client.post(`/v1/trades/quote`, {
      sourceId: sourceCurrency.id,
      targetId: targetCurrency.id,
      side,
      amount,
    });

    const { data } = response;

    return {
      id: data.id,
      rate: data.rate,
      side: data.side,
      amount: data.amount,
      expiryDate: data.expiryDate,
      amountReceived: data.amountReceived,
    }; // satisfies Quote;
  }

  /**
   * Swap from one currency to another (if you are not interested in verifying prices)
   * @param source Left hand side for pair i.e. BTC in BTC/USDT
   * @param target Right hand side for trade pair i.e. USDT in BTC/USDT
   * @param side The trade side i.e. BUY: USDT -> BTC & SELL: BTC -> USDT for BTC/USDT
   * @param amount The amount you intend to trade
   * @returns
   */
  async trade(
    source: string,
    target: string,
    side: "BUY" | "SELL",
    amount: number
  ) {
    const quote = await this.createQuote(source, target, side, amount);

    await this.acceptQuote(quote.id);

    return quote;
  }

  /**
   * Accept quote using provided quote ID
   * @param quoteId Quote ID gotten from createQuote
   * @returns
   */
  async acceptQuote(quoteId: string) {
    await this.client.post(`/v1/trades/quote/${quoteId}`);

    return true;
  }

  async withdrawCrypto(
    currencyCode: string,
    amount: number,
    wallet: CryptoAccountPayout
  ) {
    const { data: response } = await this.client.post(
      `/v1/wallets/ext/debit/crypto`,
      {
        amount,
        currency: currencyCode,
        destination: wallet,
      }
    );

    return response.data;
  }

  async withdrawNaira(amount: number, account: BankAccountPayout) {
    const { data: response } = await this.client.post(
      `/v1/wallets/ext/debit/fiat`,
      {
        amount,
        currency: "NGNX",
        destination: account,
      }
    );

    return response.data;
  }

  async getBanks() {
    const { data: response } = await this.client.get("/v1/ngn-payments/banks");

    return response.data;
  }

  async getCurrencies() {
    return await this.cacheService.getOrSet(
      "currencies",
      async () => {
        const { data: response } = await this.client.get<Response<Currency[]>>(
          "/v1/currencies"
        );

        return response.data.map((x) => ({
          id: x.id,
          name: x.name,
          code: x.code,
          receivable: x.receivable,
          withdrawable: x.withdrawable,
          transferrable: x.transferrable,
          minimumDeposit: x.minimumDeposit,
          maximumDailyDeposit: x.maximumDailyDepositLimit,
          maximumDecimalPlaces: x.maximumDecimalPlaces,
        }));
      },
      86400 // 24 Hours
    );
  }

  /**
   * @param currencyCode Get networks by currency code
   * @returns Array
   */
  async getNetworks(currencyCode: string) {
    const currency = await this.getCurrencyByCode(currencyCode);

    const { data: response } = await this.client.get<Response<Network[]>>(
      `/v1/currencies/${currency.id}/networks`
    );

    return response.data;
  }

  /**
   *
   * @param page number // default: 1
   * @param pageSize number // default: 30
   * @returns
   */
  async getNairaMerchants(page = 1, pageSize = 30) {
    const { data: response } = await this.client.get(
      `/v1/ngn-payments/merchants`,
      {
        params: {
          page,
          pageSize,
        },
      }
    );

    return response.data;
  }

  /**
   *
   * @param page number
   * @param pageSize number
   * @param category TransactionCategory
   * @returns
   */
  async getTransactionHistory(
    page = 1,
    pageSize = 30,
    category?: TransactionCategory
  ) {
    const { data } = await this.client.get(`/v1/transactions/me`, {
      params: {
        page,
        pageSize,
        category,
      },
    });

    return data;
  }

  /**
   *
   * @param page number
   * @param pageSize number
   * @returns
   */
  async getTradeHistory(page = 1, pageSize = 30) {
    const { data } = await this.client.get(`/v1/trades/me`, {
      params: {
        page,
        pageSize,
      },
    });

    return data;
  }

  async getTransactionById(transactionId: string) {
    const { data } = await this.client.get(`/v1/transactions/${transactionId}`);

    return data;
  }

  async getCurrencyByCode(code: string) {
    const currencies = await this.getCurrencies();

    return currencies.find((x) => x.code === code);
  }

  async getOrCreateWallet(currencyCode: string) {
    const { data } = await this.client.get(`/v1/wallets/${currencyCode}`);

    return data;
  }
}

export { ServerError } from "./errors/server";
