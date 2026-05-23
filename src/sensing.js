'use strict';
/**
 * S# Sensing Index Table
 * Maps sensing.category.name -> sensing index number
 */

const SENSING = {
  mouse: {
    x:        0,
    y:        1,
    down:     2,
  },
  mic: {
    loudness: 3,
  },
  time: {
    year:         4,
    month:        5,
    day:          6,
    weekday:      7,  // 1 = Sunday
    hour:         8,
    minute:       9,
    second:       10,
    timer:        11,
    daysSince2000:12,
  },
  user: {
    name:   13,
    online: 14,
  },
  key: {
    any:    15,
    space:  16,
    up:     17,
    down:   18,
    left:   19,
    right:  20,
    a: 21, b: 22, c: 23, d: 24, e: 25, f: 26, g: 27, h: 28, i: 29,
    j: 30, k: 31, l: 32, m: 33, n: 34, o: 35, p: 36, q: 37, r: 38,
    s: 39, t: 40, u: 41, v: 42, w: 43, x: 44, y: 45, z: 46,
    k1: 47, k2: 48, k3: 49, k4: 50, k5: 51,
    k6: 52, k7: 53, k8: 54, k9: 55, k0: 56,
    // Symbol keys in the order the runtime defines them
    exclaim:    58,  // !
    at:         59,  // @
    hash:       60,  // #
    dollar:     61,  // $
    percent:    62,  // %
    caret:      63,  // ^
    amp:        64,  // &
    star:       65,  // *
    lparen:     66,  // (
    rparen:     67,  // )
    lbracket:   68,  // [
    rbracket:   69,  // ]
    lbrace:     70,  // {
    rbrace:     71,  // }
    lt:         72,  // <
    gt:         73,  // >
    slash:      74,  // /
    backslash:  75,  // \
    pipe:       76,  // |
    comma:      77,  // ,
    dot:        78,  // .
    question:   79,  // ?
    semicolon:  80,  // ;
    colon:      81,  // :
    quote:      82,  // '
    dquote:     83,  // "
    minus:      84,  // -
    plus:       85,  // +
    equals:     86,  // =
    underscore: 87,  // _
    backtick:   88,  // `
    tilde:      89,  // ~
  },
};

/**
 * Resolve a sensing path array like ['mouse', 'x'] to its index.
 * Returns the integer index, or null if not found.
 */
function resolveSensing(parts) {
  if (parts.length !== 2) return null;
  const [cat, name] = parts;
  if (!SENSING[cat]) return null;
  const idx = SENSING[cat][name];
  return idx !== undefined ? idx : null;
}

module.exports = { SENSING, resolveSensing };
