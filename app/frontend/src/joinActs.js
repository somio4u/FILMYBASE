// Three files (Act 1, Act 2, Act 3) of ONE film -> one screenplay text, in order. A lone "ACT TWO" label at the very top of a part is the label of the
// part, not a line of the film, so it is dropped; nothing else is touched.
export const stripActLabel = (text) => String(text ?? '').replace(/^\s*(?:ACT\s*(?:[1-3]|ONE|TWO|THREE|I{1,3})\b[^\n]{0,40})\n/i, '')
export const joinActs = (texts) => texts.map((t) => stripActLabel(t).trim()).join('\n\n')
