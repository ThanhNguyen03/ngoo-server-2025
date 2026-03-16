import type { TWebhookData } from '@helper';

export interface ICryptoPaymentProof {
  orderId: string; // UUID
  orderIdHash: string; // bytes32 hex — keccak256 of UUID string
  amount: string; // wei as decimal string
  amountDisplay: string; // human-readable ETH (e.g. "0.0050")
  nonce: string; // bytes32 hex
  deadline: number; // unix timestamp (seconds)
  signature: string; // 0x-prefixed 65-byte hex
  contractAddress: string;
  chainId: number;
  payerAddress: string;
}

export interface ICryptoProofRedisData {
  orderId: string;
  orderIdHash: string;
  amount: string; // wei as decimal string
  nonce: string; // bytes32 hex
  deadline: number; // unix timestamp (seconds)
  payerAddress: string;
  createdAt: number; // Date.now() ms
}

export interface ICryptoMonitorConfig {
  contractAddress: string;
  rpcUrl: string;
  chainId: number;
  blockConfirmations: number;
  pollIntervalMs: number;
}

export type { TWebhookData };
