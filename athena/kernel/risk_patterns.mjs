// kernel/risk_patterns.mjs -- risk patterns more than one module has to agree on.
//
// PURCHASE_LIKE used to live in tools.mjs, where classifyRisk/irreversibleReason read it
// off a click's selector/text arguments. Module 2 now also needs it: a click by snapshot
// ref or by screen coordinates carries no text at all, so the gate in tools.mjs cannot
// see what is being clicked. modules/browser.mjs hands this pattern to the extension,
// which checks the real element's label right before the click and refuses a purchase
// control the approval gate never saw. Kept in the kernel so Module 1 and Module 2 share
// one definition without importing each other.
//
// Only actions that move money (a purchase, a booking) are matched. This is a text-match
// heuristic on the clicked element and can be wrong in either direction -- a bare
// "Submit" with no other cue is genuinely ambiguous.
export const PURCHASE_LIKE = /\b(place order|buy now|pay now|book now|confirm (order|purchase|payment|booking)|complete (purchase|order|booking|checkout)|checkout|finalize (order|booking))\b/i;
