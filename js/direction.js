/**
 * Deciding which way a line of text should run.
 *
 * The obvious answer, dir="auto", resolves from the FIRST strong character in
 * the text. That is wrong for the common Hebrew case: a line of Hebrew that
 * happens to open with an English word ("teleprompt הוא כלי") resolves to
 * left-to-right, and the whole Hebrew line then lays out backwards.
 *
 * Counting instead of peeking gets both cases right: a Hebrew line with an
 * English word in it stays right-to-left, and a fully English line inside a
 * Hebrew script still runs left-to-right.
 */

const RTL_LETTERS = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/gu;
const LTR_LETTERS = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/gu;

/**
 * @param {string} text
 * @returns {'rtl'|'ltr'} the direction the majority of the letters call for
 */
export function detectDirection(text) {
    if (!text) return 'ltr';
    const rtl = (text.match(RTL_LETTERS) || []).length;
    const ltr = (text.match(LTR_LETTERS) || []).length;
    // Digits and punctuation are deliberately not counted: they are neutral and
    // would otherwise drag a short Hebrew line ("3 כלים") the wrong way.
    return rtl > ltr ? 'rtl' : 'ltr';
}
