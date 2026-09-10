// A file a model made, filed as an upload.
//
// One function, and it is shared rather than convenient. Two things have to
// happen to a generated picture before it is stored, and one of them is not
// obvious:
//
//   1. It gets a timestamped name, so a person who makes four pictures in a
//      composer ends up with four attachments rather than four things called
//      `generated.png`.
//
//   2. It goes through `scrubMedia` FIRST. Several image hosts write the
//      prompt that produced a picture into its own EXIF, so a picture made
//      from "apology to Dana about the missed invoice" carries that sentence
//      into the recipient's inbox as metadata. Nothing about the picture looks
//      wrong; the sentence is simply in the file.
//
// It lives here because there are now two callers — the composer's own
// generate button in `routes/ai.ts`, and the assistant's `make_picture` tool —
// and a second copy of this is a second copy that can forget the scrub. That
// is not a hypothetical failure mode: the scrub is the step with no visible
// symptom when it is missing.
import { query } from '../db.js';
import { scrubMedia } from './scrub.js';
import type { DeliveredUpload, GeneratedMedia } from '../ai/media.js';

export async function fileGenerated(userId: number, media: GeneratedMedia): Promise<DeliveredUpload & { content_type: string }> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dot = media.filename.lastIndexOf('.');
  const ext = dot > 0 ? media.filename.slice(dot) : '';
  const filename = `${dot > 0 ? media.filename.slice(0, dot) : media.filename}-${stamp}${ext}`;
  const scrub = scrubMedia(media.data, media.contentType, filename);
  const rows = await query<any>(
    'INSERT INTO uploads (user_id, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, content_type, size',
    [userId, filename, media.contentType, scrub.data.length, scrub.data],
  );
  return { ...rows[0], contentType: rows[0].content_type };
}
