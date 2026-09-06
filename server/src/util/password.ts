// Password rules for logins. Length is the main defence (scrypt does the
// rest); on top of that the usual worst offenders are refused, along with
// anything built from the person's own username, so a leaked user list does
// not double as a password list.
import { badRequest } from '../errors.js';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

// The most common passwords that are long enough to pass the length rule,
// plus their keyboard-walk cousins. Compared after lowercasing and with
// digits and punctuation stripped from the ends, so "Password123!" is caught.
const COMMON = new Set([
  'password', 'passw0rd', 'password1', 'password12', 'password123', 'password1234', 'passwordpassword', 'letmein', 'welcome', 'welcome1', 'welcome123', 'iloveyou', 'sunshine', 'princess', 'football', 'baseball',
  'basketball', 'superman', 'trustno1', 'whatever', 'qwertyuiop', 'qwerty123', 'qwertyui', 'asdfghjkl', 'asdfghjk', 'zxcvbnm', '1234567890', '12345678910', '0987654321', '1q2w3e4r5t', '1qaz2wsx3edc', 'abcdefghij', 'abcdefgh',
  'administrator', 'adminadmin', 'admin1234', 'admin12345', 'changeme', 'changeme1', 'secret123', 'default', 'computer', 'internet', 'michael', 'jennifer', 'charlie', 'jordan23', 'liverpool', 'starwars', 'dragon123',
  'monkey123', 'letmein123', 'master123', 'shadow123', 'mustang', 'freedom', 'batman123', 'access14', 'hello123', 'hello1234', 'temporary', 'temp1234', 'testtest', 'test1234', 'test12345', 'guest1234', 'user1234',
  'passwort', 'motdepasse', 'contrasena', 'wachtwoord', 'senha123', 'azertyuiop', 'openssesame', 'opensesame', 'correcthorsebatterystaple',
]);

function normalize(p: string): string {
  return p.toLowerCase().replace(/^[\d\W_]+|[\d\W_]+$/g, '');
}

// A run along the alphabet, the digits or a keyboard row, forwards or backwards.
const WALKS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiopasdfghjklzxcvbnm', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p'];
function isWalk(p: string): boolean {
  const s = p.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.length < 8) return false;
  const rev = [...s].reverse().join('');
  return WALKS.some((w) => w.includes(s) || w.includes(rev) || (w + w).includes(s));
}

export function passwordProblem(password: string, username?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
  const n = normalize(password);
  if (COMMON.has(n) || COMMON.has(password.toLowerCase())) return 'That password is on every attacker\'s list; pick something less common';
  if (/^(.)\1+$/.test(password)) return 'That password is one repeated character';
  if (isWalk(password)) return 'That password is a keyboard walk; pick something less predictable';
  if (username) {
    const u = username.toLowerCase().split('@')[0];
    if (u.length >= 3 && password.toLowerCase().includes(u)) return 'The password must not contain your username';
  }
  return null;
}

export function assertPasswordOk(password: string, username?: string): void {
  const problem = passwordProblem(password, username);
  if (problem) throw badRequest(problem);
}
