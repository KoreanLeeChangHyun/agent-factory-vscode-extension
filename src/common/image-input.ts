export const MAX_IMAGE_COUNT = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export function canStageImage(currentCount: number, currentBytes: number, nextBytes: number): boolean {
  return Number.isSafeInteger(nextBytes) && nextBytes > 0 && nextBytes <= MAX_IMAGE_BYTES
    && currentCount < MAX_IMAGE_COUNT && currentBytes + nextBytes <= MAX_TOTAL_IMAGE_BYTES;
}

export function decodeBrowserImage(data: string, declaredSize: number, mediaType: string): Buffer {
  const content = Buffer.from(data, "base64");
  if (content.byteLength !== declaredSize || content.toString("base64") !== data) {
    throw new Error("이미지 첨부 데이터 크기가 일치하지 않습니다.");
  }
  if (!hasImageSignature(content, mediaType)) {
    throw new Error("이미지 내용과 미디어 형식이 일치하지 않습니다.");
  }
  return content;
}

export function hasImageSignature(content: Buffer, mediaType: string): boolean {
  if (mediaType === "image/png") return content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg") return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mediaType === "image/gif") return content.subarray(0, 6).toString("ascii") === "GIF87a" || content.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mediaType === "image/webp") return content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}
