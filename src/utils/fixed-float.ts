export interface IFixedFloat {
  basedValue: bigint;
  decimals: number;
}

export type TFixedFloatFormat = {
  signed: boolean;
  int: bigint;
  dec: bigint;
};

export type TParsedFloat = {
  int: string;
  dec: string;
  exp: string;
};

export enum ECompareResult {
  Less = -1,
  Equal = 0,
  Greater = 1,
}

export type TFixedFloatNumeric = number | string | bigint | IFixedFloat | FixedFloat;

/**
 * High-precision fixed-point arithmetic for financial or token values
 */
export class FixedFloat implements IFixedFloat {
  static ZERO = new FixedFloat(0n, 18);
  static ONE = new FixedFloat(1n * 10n ** 18n, 18);

  private _basedValue: bigint;
  private _decimals: number;

  get basedValue() {
    return this._basedValue;
  }

  get decimals() {
    return this._decimals;
  }

  private constructor(basedValue: bigint, decimals: number) {
    this._basedValue = basedValue;
    this._decimals = decimals;
  }

  /** Parse numeric input to FixedFloat */
  static from(value: TFixedFloatNumeric, decimals = 18): FixedFloat {
    if (value instanceof FixedFloat) {
      return new FixedFloat(value.basedValue, value.decimals);
    }
    if (typeof value === 'object' && 'basedValue' in value) {
      return new FixedFloat(BigInt(value.basedValue), value.decimals);
    }
    if (typeof value === 'bigint') {
      return new FixedFloat(value, decimals);
    }

    const str = String(value);
    if (!str.includes('.')) {
      return new FixedFloat(BigInt(str) * 10n ** BigInt(decimals), decimals);
    }

    const [intPart, decPart = ''] = str.split('.');
    const full = intPart + decPart.padEnd(decimals, '0').slice(0, decimals);

    return new FixedFloat(BigInt(full), decimals);
  }

  /** Convert decimals to another scale */
  toDecimal(decimals: number): FixedFloat {
    if (decimals === this.decimals) {
      return this;
    }
    const diff = decimals - this.decimals;
    return diff > 0
      ? new FixedFloat(this.basedValue * 10n ** BigInt(diff), decimals)
      : new FixedFloat(this.basedValue / 10n ** BigInt(-diff), decimals);
  }

  isZero(): boolean {
    return this.basedValue === 0n;
  }

  add(value: TFixedFloatNumeric): FixedFloat {
    const v = FixedFloat.from(value, this.decimals);
    return new FixedFloat(this.basedValue + v.basedValue, this.decimals);
  }

  sub(value: TFixedFloatNumeric): FixedFloat {
    const v = FixedFloat.from(value, this.decimals);
    return new FixedFloat(this.basedValue - v.basedValue, this.decimals);
  }

  mul(value: TFixedFloatNumeric): FixedFloat {
    const v = FixedFloat.from(value, this.decimals);
    const scaled = (this.basedValue * v.basedValue) / 10n ** BigInt(this.decimals);
    return new FixedFloat(scaled, this.decimals);
  }

  div(value: TFixedFloatNumeric): FixedFloat {
    const v = FixedFloat.from(value, this.decimals);
    const scaled = (this.basedValue * 10n ** BigInt(this.decimals)) / v.basedValue;
    return new FixedFloat(scaled, this.decimals);
  }

  /** Compare functions */
  private _compare(other: TFixedFloatNumeric): ECompareResult {
    const v = FixedFloat.from(other, this.decimals);
    if (this.basedValue < v.basedValue) return ECompareResult.Less;
    if (this.basedValue > v.basedValue) return ECompareResult.Greater;
    return ECompareResult.Equal;
  }

  eq(other: TFixedFloatNumeric): boolean {
    return this._compare(other) === ECompareResult.Equal;
  }

  gt(other: TFixedFloatNumeric): boolean {
    return this._compare(other) === ECompareResult.Greater;
  }

  gte(other: TFixedFloatNumeric): boolean {
    const r = this._compare(other);
    return r === ECompareResult.Greater || r === ECompareResult.Equal;
  }

  lt(other: TFixedFloatNumeric): boolean {
    return this._compare(other) === ECompareResult.Less;
  }

  lte(other: TFixedFloatNumeric): boolean {
    const r = this._compare(other);
    return r === ECompareResult.Less || r === ECompareResult.Equal;
  }

  /** Convert to human-readable fixed string */
  toFixed(inputDecimals: number = this.decimals): string {
    const s = this.basedValue.toString().padStart(this.decimals + 1, '0');
    const intPart = s.slice(0, -this.decimals);
    const decPart = s.slice(-this.decimals).slice(0, inputDecimals);
    return decPart ? `${intPart}.${decPart}` : intPart;
  }

  /** Pretty fiat value (6 decimals) */
  toFiatValue(): string {
    return this.toFixed(6);
  }

  /** Pretty token value (18 decimals) */
  toTokenValue(): string {
    return this.toFixed(18);
  }

  pretty(locale: Intl.LocalesArgument = 'en-US', inputDecimals = 6): string {
    const num = Number(this.toFixed(inputDecimals));
    return num.toLocaleString(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: inputDecimals,
    });
  }

  prettyAuto(locale: Intl.LocalesArgument = 'en-US', inputDecimals = 6): string {
    if (this.isZero()) return '0';
    const value = Number(this.toFixed(inputDecimals));
    return value.toLocaleString(locale, {
      maximumFractionDigits: inputDecimals,
    });
  }
}

export default FixedFloat;
