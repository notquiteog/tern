// A settings card's form, after one of its saves.
//
// The cards on Admin → AI model hold one form each and save it in pieces: a
// switch saves itself the moment it is flipped, and a card with two halves has
// a Save button for each. Every save used to replace the whole form with the
// server's copy, which silently threw away anything typed but not yet saved —
// type a voice model, flip the voice on, and the switch's own save put the
// stored (empty) model back, so "Save the voice" then saved nothing at all.
//
// So a save refreshes only what it has a claim to. The fields it sent take the
// server's value, which is how a trimmed address or a clamped speed shows up.
// The fields nobody has touched take the server's value too, which is how a
// switch the server turned off — because there is nowhere left to send to —
// still shows as off. What is left is a field the person changed and this save
// did not carry, and that keeps what they typed. A save that carries every
// changed field therefore still ends with exactly the server's copy.

/**
 * @param form   what is on screen now
 * @param before what the server held before this save — the card's last copy
 * @param saved  what the server answered with
 * @param sent   the patch this save sent; its keys are the fields it carried
 */
export function mergeSaved<T extends Record<string, unknown>>(
  form: T,
  before: Partial<T> | null | undefined,
  saved: T,
  sent: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...saved };
  for (const [k, v] of Object.entries(form)) {
    if (k in sent) continue;
    if (!sameValue(v, before?.[k])) out[k] = v;
  }
  return out as T;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Lists compared by what is in them: a list the form rebuilt with the same
  // entries is not an edit.
  return typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}
