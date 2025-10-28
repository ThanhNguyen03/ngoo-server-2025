import { ByteBuffer, FixedFloat, THexString } from '@/lib';
import { Contract, Signer } from 'ethers';

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
