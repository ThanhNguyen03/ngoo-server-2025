import { isAddress } from 'ethers';
import Joi from 'joi';

export type THexString = `0x${string}`;
export type TBigSerial = string | bigint;
/** Validate an Ethereum address including the encoded checksum, and convert it
 * to lowercase to ensure consistency. */
export const JOI_ERC55_ADDRESS = Joi.string()
  .trim()
  .custom((value) => {
    if (isAddress(value) === false) {
      throw new Error('Invalid address');
    }

    // NOTE: using Joi.lowercase() will convert the entire string to lowercase
    // before our custom validator is called regardless of the schema chain
    // order. We want to convert the address to lowercase after address checksum
    // validation.
    return value.toLowerCase();
  });

/**
 * Executes an async function and returns `true` on success or `false` on
 * failure. Errors are intentionally swallowed — callers use the boolean
 * result for control flow (e.g. logout success/failure).
 *
 * This is the fixed version of the original deferred anti-pattern which used
 * `new Promise` wrapping a `.then()/.catch()` chain — mixing the callback and
 * async styles unnecessarily.
 */
export const isOk = async (asyncFunction: () => Promise<unknown>): Promise<boolean> => {
  try {
    await asyncFunction();
    return true;
  } catch {
    return false;
  }
};

export default isOk;
export * from './authen';
export * from './byte-buffer';
export * from './errors';
export * from './fixed-float';
export * from './logger';
export * from './queue';
