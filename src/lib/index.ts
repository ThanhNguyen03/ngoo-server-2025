import Joi from 'joi';
import { isAddress } from 'ethers';

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

export const isOk = (asyncFunction: (...args: any[]) => Promise<any>): Promise<boolean> => {
  return new Promise((resolve) => {
    asyncFunction()
      .then(() => {
        resolve(true);
      })
      .catch((error) => {
        console.error('Found an error, when check if the function was successful or not: ', error);
        resolve(false);
      });
  });
};

export default isOk;
export * from './authen';
export * from './byte-buffer';
export * from './fixed-float';
export * from './redis';
