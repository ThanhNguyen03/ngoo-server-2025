/**
 * ETH price oracle using CoinGecko free API.
 *
 * Caches the ETH/USD price in Redis to avoid hammering the API.
 * Falls back to the cached price (if < 5 min old) when the API is down.
 * Throws PaymentError if no price is available.
 *
 * Free tier: 10-30 calls/min. With 60s cache = max 1 call/min.
 */
import { RedisHelper } from '@helper';
import { createLogger, PaymentError, ValidationError } from '@lib';
import axios from 'axios';

const logger = createLogger('CryptoPriceOracle');

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';

interface ICoinGeckoResponse {
  ethereum: {
    usd: number;
  };
}

// Maximum allowed price deviation between consecutive CoinGecko fetches.
// A >30% swing in one cache interval (60s) is almost certainly an API anomaly,
// not a real market move, and accepting it could let users pay far too little.
const MAX_PRICE_DEVIATION_RATIO = 0.3;

/**
 * Fetch ETH/USD price from CoinGecko with Redis caching.
 * - Primary cache: CRYPTO_PRICE_CACHE_TTL_SEC (default 60s)
 * - Last-known fallback: 5-minute TTL — used when CoinGecko is unreachable
 *   and the primary cache has expired. Prevents hard failures during brief outages.
 * - Bounds check: rejects a new price that deviates >30% from the last known price.
 * @returns ETH price in USD as a number (e.g. 3500.25)
 */
export async function getEthPriceUsd(): Promise<number> {
  // 1. Try primary cache first (short TTL, CoinGecko-fresh)
  const cached = await RedisHelper.crypto.ethPriceGet();
  if (cached !== null) {
    const price = parseFloat(cached);
    if (!isNaN(price) && price > 0) {
      logger.debug({ price }, 'ETH price from cache');
      return price;
    }
  }

  // 2. Fetch from CoinGecko
  try {
    const response = await axios.get<ICoinGeckoResponse>(COINGECKO_URL, {
      timeout: 5000,
    });

    const price = response.data?.ethereum?.usd;
    if (!price || typeof price !== 'number' || price <= 0) {
      throw new Error('Invalid price response from CoinGecko');
    }

    // 4.1: Bounds check — reject anomalous price spikes/crashes.
    // Compares against the last-known price to detect potential API bugs or
    // cache poisoning. A >30% deviation in one cache interval is suspicious.
    const lastKnown = await RedisHelper.crypto.ethPriceLastKnownGet();
    if (lastKnown !== null) {
      const lastPrice = parseFloat(lastKnown);
      if (lastPrice > 0) {
        const deviation = Math.abs(price - lastPrice) / lastPrice;
        if (deviation > MAX_PRICE_DEVIATION_RATIO) {
          logger.error(
            { newPrice: price, lastKnownPrice: lastPrice, deviation },
            'ETH price deviates >30% from last known — rejecting to prevent underpayment',
          );
          throw new PaymentError('ETH price is unstable. Please try again shortly.');
        }
      }
    }

    // Cache the fresh price in both the primary (short TTL) and last-known (5 min) stores.
    await RedisHelper.crypto.ethPriceSet(String(price));
    await RedisHelper.crypto.ethPriceLastKnownSet(String(price));
    logger.info({ price }, 'ETH price fetched from CoinGecko');
    return price;
  } catch (fetchErr) {
    // Re-throw PaymentError from bounds check directly — don't try stale fallback.
    if (fetchErr instanceof PaymentError) throw fetchErr;

    logger.warn({ err: fetchErr }, 'CoinGecko fetch failed, checking last-known price');

    // 4.2: Stale fallback — use the last-known price (up to 5 min old) when
    // CoinGecko is temporarily unreachable. Avoids hard failures during brief outages.
    const lastKnown = await RedisHelper.crypto.ethPriceLastKnownGet();
    if (lastKnown !== null) {
      const price = parseFloat(lastKnown);
      if (!isNaN(price) && price > 0) {
        logger.warn({ price }, 'Using last-known ETH price as CoinGecko fallback');
        return price;
      }
    }

    throw new PaymentError('ETH price unavailable. Please try again in a moment.');
  }
}

/**
 * Convert a USD amount to wei (18 decimals) using the current ETH price.
 * @param usdAmount - USD amount as a number (e.g. 12.50 for $12.50)
 * @returns Wei amount as a decimal string (e.g. "20161290322580645")
 */
export async function usdToWei(usdAmount: number): Promise<string> {
  if (usdAmount <= 0) {
    throw new ValidationError('USD amount must be positive');
  }

  const ethPrice = await getEthPriceUsd();

  // ethAmount = usdAmount / ethPrice
  // Convert to wei (18 decimals): wei = ethAmount * 10^18
  // Use BigInt to avoid floating-point precision issues
  // Scale: multiply numerator by 10^18 before dividing
  const USD_SCALE = 1_000_000n; // 6 decimal places for USD input
  const usdAmountScaled = BigInt(Math.round(usdAmount * Number(USD_SCALE)));
  const ethPriceScaled = BigInt(Math.round(ethPrice * Number(USD_SCALE)));

  // wei = (usdAmountScaled * 10^18) / ethPriceScaled
  const weiAmount = (usdAmountScaled * 10n ** 18n) / ethPriceScaled;

  logger.debug({ usdAmount, ethPrice, weiAmount: weiAmount.toString() }, 'Converted USD to wei');
  return weiAmount.toString();
}

/**
 * Format wei amount to human-readable ETH string (4 decimal places).
 * @param weiAmount - Wei amount as decimal string
 * @returns Human-readable ETH string (e.g. "0.0050")
 */
export function formatWeiToEth(weiAmount: string): string {
  const wei = BigInt(weiAmount);
  const ethWhole = wei / 10n ** 18n;
  const ethFrac = wei % 10n ** 18n;
  const fracStr = ethFrac.toString().padStart(18, '0').slice(0, 4);
  return `${ethWhole}.${fracStr}`;
}
