const f = (n, sign) => {
  const s = Math.abs(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  if (sign) return (n < 0 ? '−' : '+') + s;
  return (n < 0 ? '−' : '') + s;
};
const groups = [
  ['Logement', [['Loyer', 850, 850], ['Électricité', 65, 58.2], ['Internet', 30, 29.99]]],
  ['Quotidien', [['Courses', 420, 287.45], ['Transport', 90, 104.3], ['Santé', 40, 12]]],
  ['Loisirs', [['Restaurants', 120, 96.8], ['Sorties', 60, 18], ['Abonnements', 35, 35.97]]],
  ['Épargne', [['Vacances', 150, 0], ['Imprévus', 100, 0]]],
];
export const budgetRows = [];
let tb = 0, ts = 0;
groups.forEach(([g, cats]) => {
  const gb = cats.reduce((a, c) => a + c[1], 0), gs = cats.reduce((a, c) => a + c[2], 0);
  budgetRows.push({ group: true, name: g, budgeted: f(gb), spent: f(-gs), avail: f(gb - gs), state: 'group' });
  cats.forEach(([n, b, s]) => {
    tb += b; ts += s;
    const a = Math.round((b - s) * 100) / 100;
    budgetRows.push({ group: false, name: n, budgeted: f(b), spent: s ? f(-s) : '0,00 €', avail: f(a), state: a < 0 ? 'neg' : a === 0 ? 'zero' : 'pos', pct: Math.min(100, Math.round((s / b) * 100)) + '%' });
  });
});
export const totals = { toBudget: '312,40 €', budgeted: f(tb), spent: f(ts), month: 'Octobre 2026', income: '2 840,00 €' };
export const accounts = [
  { name: 'Compte courant', bal: '3 214,56 €' },
  { name: 'Livret A', bal: '8 400,00 €' },
  { name: 'Carte de crédit', bal: '−312,80 €' },
];
const tx = [
  ['02 oct.', 'Monoprix', 'Courses', -42.18],
  ['01 oct.', 'Salaire', 'Revenu', 2840],
  ['01 oct.', 'Foncia', 'Loyer', -850],
  ['30 sept.', 'Boulangerie Paul', 'Restaurants', -6.4],
  ['29 sept.', 'TotalEnergies', 'Transport', -58.3],
  ['28 sept.', 'Netflix', 'Abonnements', -13.49],
  ['27 sept.', 'Le Comptoir', 'Restaurants', -38.5],
  ['26 sept.', 'Picard', 'Courses', -24.9],
  ['25 sept.', 'EDF', 'Électricité', -58.2],
];
let bal = 3214.56;
export const txns = tx.map(([date, payee, cat, amt]) => {
  const r = { date, payee, cat, amt: f(amt, true), pos: amt > 0, balance: f(bal) };
  bal -= amt;
  return r;
});
const rc = [['Logement', 938.19], ['Courses', 287.45], ['Restaurants', 96.8], ['Transport', 104.3], ['Abonnements', 35.97], ['Autres', 30]];
const max = rc[0][1];
export const reportCats = rc.map(([name, v]) => ({ name, amount: f(v), w: Math.round((v / max) * 100) + '%' }));
const m = [['mai', 1720], ['juin', 1890], ['juil.', 2210], ['août', 1640], ['sept.', 1810], ['oct.', 1492]];
export const months = m.map(([label, v], i) => ({ label, h: Math.round((v / 2300) * 100) + '%', current: i === m.length - 1 }));
export const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];
export const report = { spent: '1 492,71 €', vsLast: '−17,5 % vs sept.', budgeted: '1 960,00 €' };
