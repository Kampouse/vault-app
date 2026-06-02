// LEB128 decoder for NEAR borsh values
export function decodeUnsignedLEB128(bytes: Uint8Array, offset = 0): { value: bigint; bytesConsumed: number } {
  let result = 0n;
  let shift = 0n;
  let consumed = 0;
  for (let i = offset; i < bytes.length; i++) {
    const byte = bytes[i];
    consumed++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, bytesConsumed: consumed };
}
