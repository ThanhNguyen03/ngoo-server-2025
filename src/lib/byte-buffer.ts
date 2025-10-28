import { Buffer } from 'safer-buffer';
import { ethers } from 'ethers';
import { THexString } from '.';

export type TNumberLike = THexString | bigint | number;

export class ByteBuffer {
  private buf: Buffer = Buffer.alloc(0);

  /** Factory method */
  static getInstance(): ByteBuffer {
    return new ByteBuffer();
  }

  /** Internal generic uint writer */
  private writeUint(value: TNumberLike, byteLen: number): this {
    const bigintValue: bigint = BigInt(value);

    const hex = bigintValue.toString(16).padStart(byteLen * 2, '0');
    const bytes = Buffer.from(hex, 'hex');
    this.buf = Buffer.concat([this.buf, bytes]);
    return this;
  }

  /** Write Ethereum address (20 bytes) */
  writeAddress(address: TNumberLike): this {
    const clean = ethers.getAddress(address.toString());
    const bytes = Buffer.from(clean.slice(2), 'hex');
    this.buf = Buffer.concat([this.buf, bytes]);
    return this;
  }

  /** Generate all writeUintX methods */
  writeUint8(input: TNumberLike) {
    return this.writeUint(input, 1);
  }
  writeUint16(input: TNumberLike) {
    return this.writeUint(input, 2);
  }
  writeUint32(input: TNumberLike) {
    return this.writeUint(input, 4);
  }
  writeUint64(input: TNumberLike) {
    return this.writeUint(input, 8);
  }
  writeUint96(input: TNumberLike) {
    return this.writeUint(input, 12);
  }
  writeUint128(input: TNumberLike) {
    return this.writeUint(input, 16);
  }
  writeUint256(input: TNumberLike) {
    return this.writeUint(input, 32);
  }

  /** Append arbitrary bytes (hex string) */
  writeBytes(bytes: THexString): this {
    const clean = bytes.startsWith('0x') ? bytes.slice(2) : bytes;
    const buf = Buffer.from(clean, 'hex');
    this.buf = Buffer.concat([this.buf, buf]);
    return this;
  }

  /** Append bytes, padded/truncated to fixed length */
  writeFixedBytes(bytes: THexString, byteLen: number): this {
    const clean = bytes.startsWith('0x') ? bytes.slice(2) : bytes;
    const buf = Buffer.from(clean, 'hex');
    const fixed = Buffer.alloc(byteLen);
    buf.copy(fixed, 0, 0, Math.min(byteLen, buf.length));
    this.buf = Buffer.concat([this.buf, fixed]);
    return this;
  }

  /** Return hex string */
  invoke(): THexString {
    return `0x${this.buf.toString('hex')}` as THexString;
  }

  /** Return raw Buffer */
  invokeBuffer(): Buffer {
    return this.buf;
  }
}

export default ByteBuffer;
