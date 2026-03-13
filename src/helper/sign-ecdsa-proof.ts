import { ByteBuffer, FixedFloat, THexString } from '@lib';
import { Contract, Signer } from 'ethers';

/**
 * @deprecated This helper is used only for the legacy off-chain claim flow
 * (a separate contract, not NgooPayment). It is NOT part of the crypto payment
 * flow introduced in Sprint 4.2 — that flow uses `CryptoPaymentService.generatePaymentProof()`
 * with `AbiCoder.defaultAbiCoder().encode(...)` for on-chain signature verification.
 *
 * Do not use `SignEcdsaProof` for new payment features.
 */
export class SignEcdsaProof {
  static async buildSignedCalldata(params: {
    remoteWallet: Signer;
    contractAddress: string;
    abi: any;
    userAddress: THexString;
    nonce: bigint;
    timestamp: bigint | number;
    amount: FixedFloat | bigint;
  }): Promise<string> {
    const { remoteWallet, contractAddress, abi, userAddress, nonce, timestamp, amount } = params;
    const claimAmount = amount instanceof FixedFloat ? amount.basedValue : amount;

    const rawProof = ByteBuffer.getInstance()
      .writeAddress(userAddress)
      .writeUint96(BigInt(nonce))
      .writeUint64(BigInt(timestamp))
      .writeUint128(claimAmount)
      .invoke();

    const signature = await remoteWallet.signMessage(rawProof);

    const signatureBytes = ByteBuffer.getInstance()
      .writeBytes(signature as THexString)
      .writeBytes(rawProof)
      .invoke();

    const contract = new Contract(contractAddress, abi, remoteWallet);
    const calldata = contract.interface.encodeFunctionData('claim', [signatureBytes]);

    return calldata;
  }
}

export default SignEcdsaProof;
