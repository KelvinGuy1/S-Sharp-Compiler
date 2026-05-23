'use strict';
/**
 * S# Lexer
 */

const TT = {
  INT:'INT', FLOAT:'FLOAT', STRING:'STRING', BOOL:'BOOL',
  IDENT:'IDENT', KEYWORD:'KEYWORD',
  PLUS:'PLUS', MINUS:'MINUS', STAR:'STAR', SLASH:'SLASH', PERCENT:'PERCENT',
  AMPAMP:'AMPAMP', PIPEPIPE:'PIPEPIPE', BANG:'BANG',
  EQ:'EQ', EQEQ:'EQEQ', NEQ:'NEQ', LT:'LT', GT:'GT', LTE:'LTE', GTE:'GTE',
  PLUSEQ:'PLUSEQ', MINUSEQ:'MINUSEQ', STAREQ:'STAREQ', SLASHEQ:'SLASHEQ',
  PLUSPLUS:'PLUSPLUS', MINUSMINUS:'MINUSMINUS',
  LPAREN:'LPAREN', RPAREN:'RPAREN', LBRACE:'LBRACE', RBRACE:'RBRACE',
  LBRACKET:'LBRACKET', RBRACKET:'RBRACKET',
  SEMICOLON:'SEMICOLON', COLON:'COLON', COMMA:'COMMA', DOT:'DOT',
  ARROW:'ARROW', AT:'AT', HASH:'HASH',
  EOF:'EOF',
};

const KEYWORDS = new Set([
  'fn','return','let','const','if','else','while','for',
  'break','continue','struct','new',
  'true','false','null','int','float','bool','string','void',
  'entity','component','self','broadcast','wait','jump',
  'asm','extern','inline','static','import',
]);

class Token {
  constructor(type, value, line, col, startPos) {
    this.type = type;
    this.value = value;
    this.line = line;
    this.col = col;
    this.startPos = startPos; // byte offset in source
  }
}

class LexError extends Error {
  constructor(msg, line, col, file) {
    super(`${file}:${line}:${col}: Lex error: ${msg}`);
  }
}

class Lexer {
  constructor(source, filename = '<stdin>') {
    this.src = source;
    this.file = filename;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.tokens = [];
  }

  error(msg) { throw new LexError(msg, this.line, this.col, this.file); }
  peek(offset=0) { return this.src[this.pos+offset]; }

  advance() {
    const ch = this.src[this.pos++];
    if (ch==='\n') { this.line++; this.col=1; } else { this.col++; }
    return ch;
  }

  match(ch) {
    if (this.src[this.pos]===ch) { this.advance(); return true; }
    return false;
  }

  skipWhitespaceAndComments() {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch===' '||ch==='\t'||ch==='\r'||ch==='\n') { this.advance(); }
      else if (ch==='/'&&this.peek(1)==='/') {
        while (this.pos<this.src.length&&this.peek()!=='\n') this.advance();
      } else if (ch==='/'&&this.peek(1)==='*') {
        this.advance(); this.advance();
        while (this.pos<this.src.length) {
          if (this.peek()==='*'&&this.peek(1)==='/') { this.advance(); this.advance(); break; }
          this.advance();
        }
      } else break;
    }
  }

  readString() {
    const sl=this.line,sc=this.col,sp=this.pos;
    this.advance();
    let str='';
    while (this.pos<this.src.length&&this.peek()!=='"') {
      if (this.peek()==='\\') {
        this.advance();
        const e=this.advance();
        switch(e){case 'n':str+='\n';break;case 't':str+='\t';break;
          case 'r':str+='\r';break;case '"':str+='"';break;
          case '\\':str+='\\';break;default:str+='\\'+e;}
      } else str+=this.advance();
    }
    if (this.pos>=this.src.length) this.error('Unterminated string literal');
    this.advance();
    return new Token(TT.STRING, str, sl, sc, sp);
  }

  readNumber() {
    const sl=this.line,sc=this.col,sp=this.pos;
    let num=''; let isFloat=false;
    while (this.pos<this.src.length&&/[0-9]/.test(this.peek())) num+=this.advance();
    if (this.peek()==='.'&&/[0-9]/.test(this.peek(1))) {
      isFloat=true; num+=this.advance();
      while (this.pos<this.src.length&&/[0-9]/.test(this.peek())) num+=this.advance();
    }
    if (this.peek()==='e'||this.peek()==='E') {
      isFloat=true; num+=this.advance();
      if (this.peek()==='+'||this.peek()==='-') num+=this.advance();
      while (/[0-9]/.test(this.peek())) num+=this.advance();
    }
    return new Token(isFloat?TT.FLOAT:TT.INT,
      isFloat?parseFloat(num):parseInt(num,10), sl, sc, sp);
  }

  readIdent() {
    const sl=this.line,sc=this.col,sp=this.pos;
    let word='';
    while (this.pos<this.src.length&&/[a-zA-Z0-9_]/.test(this.peek())) word+=this.advance();
    if (word==='true'||word==='false') return new Token(TT.BOOL, word==='true', sl, sc, sp);
    return new Token(KEYWORDS.has(word)?TT.KEYWORD:TT.IDENT, word, sl, sc, sp);
  }

  tokenize() {
    while (true) {
      this.skipWhitespaceAndComments();
      const sp = this.pos;
      if (this.pos>=this.src.length) {
        this.tokens.push(new Token(TT.EOF, null, this.line, this.col, sp));
        break;
      }
      const sl=this.line, sc=this.col;
      const ch=this.peek();

      if (ch==='"') { this.tokens.push(this.readString()); continue; }
      if (/[0-9]/.test(ch)) { this.tokens.push(this.readNumber()); continue; }
      if (/[a-zA-Z_]/.test(ch)) { this.tokens.push(this.readIdent()); continue; }

      this.advance();
      const tok=(t,v)=>new Token(t,v,sl,sc,sp);
      switch (ch) {
        case '+':
          if (this.match('+')) this.tokens.push(tok(TT.PLUSPLUS,'++'));
          else if (this.match('=')) this.tokens.push(tok(TT.PLUSEQ,'+='));
          else this.tokens.push(tok(TT.PLUS,'+'));
          break;
        case '-':
          if (this.match('-')) this.tokens.push(tok(TT.MINUSMINUS,'--'));
          else if (this.match('=')) this.tokens.push(tok(TT.MINUSEQ,'-='));
          else if (this.match('>')) this.tokens.push(tok(TT.ARROW,'->'));
          else this.tokens.push(tok(TT.MINUS,'-'));
          break;
        case '*':
          if (this.match('=')) this.tokens.push(tok(TT.STAREQ,'*='));
          else this.tokens.push(tok(TT.STAR,'*'));
          break;
        case '/':
          if (this.match('=')) this.tokens.push(tok(TT.SLASHEQ,'/='));
          else this.tokens.push(tok(TT.SLASH,'/'));
          break;
        case '%': this.tokens.push(tok(TT.PERCENT,'%')); break;
        case '&':
          if (this.match('&')) this.tokens.push(tok(TT.AMPAMP,'&&'));
          else this.error('Bitwise & not supported; use &&');
          break;
        case '|':
          if (this.match('|')) this.tokens.push(tok(TT.PIPEPIPE,'||'));
          else this.error('Bitwise | not supported; use ||');
          break;
        case '!':
          if (this.match('=')) this.tokens.push(tok(TT.NEQ,'!='));
          else this.tokens.push(tok(TT.BANG,'!'));
          break;
        case '=':
          if (this.match('=')) this.tokens.push(tok(TT.EQEQ,'=='));
          else this.tokens.push(tok(TT.EQ,'='));
          break;
        case '<':
          if (this.match('=')) this.tokens.push(tok(TT.LTE,'<='));
          else this.tokens.push(tok(TT.LT,'<'));
          break;
        case '>':
          if (this.match('=')) this.tokens.push(tok(TT.GTE,'>='));
          else this.tokens.push(tok(TT.GT,'>'));
          break;
        case '(': this.tokens.push(tok(TT.LPAREN,'(')); break;
        case ')': this.tokens.push(tok(TT.RPAREN,')')); break;
        case '{': this.tokens.push(tok(TT.LBRACE,'{')); break;
        case '}': this.tokens.push(tok(TT.RBRACE,'}')); break;
        case '[': this.tokens.push(tok(TT.LBRACKET,'[')); break;
        case ']': this.tokens.push(tok(TT.RBRACKET,']')); break;
        case ';': this.tokens.push(tok(TT.SEMICOLON,';')); break;
        case ':': this.tokens.push(tok(TT.COLON,':')); break;
        case ',': this.tokens.push(tok(TT.COMMA,',')); break;
        case '.': this.tokens.push(tok(TT.DOT,'.')); break;
        case '@': this.tokens.push(tok(TT.AT,'@')); break;
        case '#': this.tokens.push(tok(TT.HASH,'#')); break;
        default: this.error(`Unexpected character '${ch}'`);
      }
    }
    return this.tokens;
  }
}

module.exports = { Lexer, Token, TT, KEYWORDS };
