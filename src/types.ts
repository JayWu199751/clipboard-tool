export interface ClipboardEntry {
  id: string;
  type: 'text' | 'image';
  text?: string;
  dataUrl?: string;
  createdAt: number;
}
