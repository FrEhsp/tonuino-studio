import { FolderSticker } from '../stickers/FolderSticker';
import { shelfSource } from './shelfCards';

/**
 * A folder's card on the shelf: built from its original cover, standing as
 * the shelf's cards stand, or its sticker as printed. Until a card is
 * built, the sticker shows in the same shape.
 */
export function ShelfSticker({ folder, title }: { folder: number; title: string }) {
  const src = shelfSource(folder, title);
  return <FolderSticker folder={folder} title={title} orientation={src.orientation} card={src.card} />;
}
