/**
 * P16 — Token-2022 extensions, decoded rather than assumed absent.
 *
 * Several of these can take a position from its holder or freeze it in place:
 *
 *   permanent delegate      a third party can transfer the tokens at will
 *   transfer hook           arbitrary program code runs on every transfer
 *   non-transferable        the position can never be sold
 *   pausable                transfers can be stopped after entry
 *   default account state   new accounts arrive frozen
 *   permissioned burn       a third party can destroy the balance
 *
 * A mint carrying any of them is not a token that happens to have a feature. It
 * is a token whose exit is contingent on somebody else's cooperation, and the
 * screening gate has been treating every mint as though none of them existed.
 *
 * An UNKNOWN extension is the important case. Token-2022 is extensible, so an
 * extension type this build does not recognise may do anything at all —
 * including all of the above. It is graded as unknown money-critical behaviour
 * rather than ignored: separate cohort in development, hard veto with capital
 * at risk.
 */

export const MINT_EXTENSION = {
  TransferFeeConfig: 1,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  DefaultAccountState: 6,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  PermanentDelegate: 12,
  TransferHook: 14,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  Pausable: 26,
} as const;

/** Extensions that can cost the holder the position, not merely surprise them. */
const MONEY_CRITICAL = new Set<number>([
  MINT_EXTENSION.PermanentDelegate,
  MINT_EXTENSION.TransferHook,
  MINT_EXTENSION.NonTransferable,
  MINT_EXTENSION.Pausable,
  MINT_EXTENSION.DefaultAccountState,
  MINT_EXTENSION.ConfidentialTransferMint,
]);

const NAME_BY_TYPE: ReadonlyMap<number, string> = new Map(
  Object.entries(MINT_EXTENSION).map(([name, type]) => [type as number, name]),
);

/** The base mint is 82 bytes; extensions follow a 1-byte account type at 165. */
const MINT_BASE_LEN = 82;
const EXTENSION_START = 166;
const ACCOUNT_TYPE_MINT = 1;

export interface DecodedExtension {
  readonly type: number;
  /** Null when this build does not recognise the type. */
  readonly name: string | null;
  readonly length: number;
  readonly moneyCritical: boolean;
  /** True when the type is not in this build's table at all. */
  readonly unknown: boolean;
}

export interface Token2022Facts {
  readonly isToken2022: boolean;
  readonly extensions: readonly DecodedExtension[];
  /** Transfer fee in basis points, when the mint declares one. */
  readonly transferFeeBps: number | null;
  readonly maximumFee: bigint | null;
  /**
   * Whether anything here can cost the holder the position.
   *
   * True for a recognised money-critical extension AND for any unrecognised
   * one, because an extension this build cannot name may do anything at all.
   */
  readonly hasMoneyCriticalBehaviour: boolean;
  readonly hasUnknownExtension: boolean;
  /** Why, in words, so a refusal can be argued with. */
  readonly detail: string;
}

const EMPTY: Token2022Facts = {
  isToken2022: false,
  extensions: [],
  transferFeeBps: null,
  maximumFee: null,
  hasMoneyCriticalBehaviour: false,
  hasUnknownExtension: false,
  detail: 'legacy SPL Token mint; the extension model does not apply',
};

/**
 * Decode a Token-2022 mint's extensions from its account data.
 *
 * Returns `EMPTY` for a legacy mint, which is a statement that the extension
 * model does not apply — not that the extensions were checked and found absent.
 *
 * Malformed TLV stops the walk and is reported as an unknown extension rather
 * than silently truncating the list. A list that ended early because the bytes
 * were bad looks exactly like a mint with fewer extensions.
 */
export function decodeToken2022Mint(data: Uint8Array, ownerProgram: string): Token2022Facts {
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  if (ownerProgram !== TOKEN_2022) return EMPTY;
  // A Token-2022 mint with no extensions is exactly the base length.
  if (data.length <= MINT_BASE_LEN) {
    return { ...EMPTY, isToken2022: true, detail: 'Token-2022 mint with no extensions' };
  }
  if (data.length < EXTENSION_START) {
    return {
      ...EMPTY,
      isToken2022: true,
      hasUnknownExtension: true,
      hasMoneyCriticalBehaviour: true,
      detail: `Token-2022 mint of ${data.length} bytes: too short to carry the account type but longer than a base mint`,
    };
  }
  if (data[MINT_BASE_LEN + 83] !== ACCOUNT_TYPE_MINT && data[165] !== ACCOUNT_TYPE_MINT) {
    // The account-type byte sits at 165 for both mints and accounts. A value
    // that is not Mint here means this is not a mint, and decoding it as one
    // would produce confident nonsense.
    return {
      ...EMPTY,
      isToken2022: true,
      hasUnknownExtension: true,
      hasMoneyCriticalBehaviour: true,
      detail: 'Token-2022 account type is not Mint; refusing to decode it as one',
    };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const extensions: DecodedExtension[] = [];
  let transferFeeBps: number | null = null;
  let maximumFee: bigint | null = null;
  let at = EXTENSION_START;
  let malformed = false;

  while (at + 4 <= data.length) {
    const type = view.getUint16(at, true);
    const len = view.getUint16(at + 2, true);
    const valueAt = at + 4;
    if (valueAt + len > data.length) {
      malformed = true;
      break;
    }
    // Type 0 is the padding/uninitialised marker; the walk is done.
    if (type === 0 && len === 0) break;

    const name = NAME_BY_TYPE.get(type) ?? null;
    extensions.push({
      type,
      name,
      length: len,
      moneyCritical: MONEY_CRITICAL.has(type),
      unknown: name === null,
    });

    if (type === MINT_EXTENSION.TransferFeeConfig && len >= 108) {
      // The newer of the two fee configs sits at the end of the extension:
      // epoch(8) + maximumFee(8) + basisPoints(2). Read from the tail so a
      // layout change at the front cannot silently shift the fee.
      maximumFee = view.getBigUint64(valueAt + len - 10, true);
      transferFeeBps = view.getUint16(valueAt + len - 2, true);
    }

    at = valueAt + len;
  }

  const unknown = extensions.filter((e) => e.unknown);
  const critical = extensions.filter((e) => e.moneyCritical);
  const hasUnknown = unknown.length > 0 || malformed;

  const parts: string[] = [];
  if (extensions.length === 0) parts.push('no extensions');
  else parts.push(`${extensions.length} extension(s): ${extensions.map((e) => e.name ?? `unknown#${e.type}`).join(', ')}`);
  if (transferFeeBps !== null) parts.push(`transfer fee ${transferFeeBps}bps (max ${maximumFee})`);
  if (critical.length > 0) parts.push(`MONEY-CRITICAL: ${critical.map((e) => e.name).join(', ')}`);
  if (malformed) parts.push('the extension list is malformed and stopped early');
  if (unknown.length > 0) parts.push(`${unknown.length} unrecognised extension type(s)`);

  return {
    isToken2022: true,
    extensions,
    transferFeeBps,
    maximumFee,
    // An unrecognised extension counts as money-critical: this build cannot say
    // what it does, and "we do not know" is not "it is harmless".
    hasMoneyCriticalBehaviour: critical.length > 0 || hasUnknown,
    hasUnknownExtension: hasUnknown,
    detail: parts.join('; '),
  };
}
