export const MAX_IMAGE_COUNT = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export function canStageImage(currentCount: number, currentBytes: number, nextBytes: number): boolean {
  return Number.isSafeInteger(nextBytes) && nextBytes > 0 && nextBytes <= MAX_IMAGE_BYTES
    && currentCount < MAX_IMAGE_COUNT && currentBytes + nextBytes <= MAX_TOTAL_IMAGE_BYTES;
}
