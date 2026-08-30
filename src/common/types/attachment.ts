export type AttachmentKind = "file" | "folder" | "image";

export interface AttachmentReference {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly size?: number;
}
