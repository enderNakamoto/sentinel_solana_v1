// Shared data: airports, flights, vault stats. All mocked for the prototype.

const AIRPORTS = {
  SFO: { name: 'San Francisco', city: 'SFO', lat: 37.62, lon: -122.38, country: 'US' },
  JFK: { name: 'New York JFK',  city: 'JFK', lat: 40.64, lon: -73.78,  country: 'US' },
  LAX: { name: 'Los Angeles',   city: 'LAX', lat: 33.94, lon: -118.40, country: 'US' },
  ORD: { name: 'Chicago O\u2019Hare', city: 'ORD', lat: 41.97, lon: -87.91,  country: 'US' },
  ATL: { name: 'Atlanta',       city: 'ATL', lat: 33.64, lon: -84.43,  country: 'US' },
  DFW: { name: 'Dallas-Fort Worth', city: 'DFW', lat: 32.90, lon: -97.04, country: 'US' },
  LHR: { name: 'London Heathrow', city: 'LHR', lat: 51.47, lon: -0.45, country: 'UK' },
  CDG: { name: 'Paris Charles de Gaulle', city: 'CDG', lat: 49.01, lon: 2.55, country: 'FR' },
  FRA: { name: 'Frankfurt',     city: 'FRA', lat: 50.04, lon: 8.56,   country: 'DE' },
  AMS: { name: 'Amsterdam',     city: 'AMS', lat: 52.31, lon: 4.76,   country: 'NL' },
  DXB: { name: 'Dubai',         city: 'DXB', lat: 25.25, lon: 55.36,  country: 'AE' },
  SIN: { name: 'Singapore',     city: 'SIN', lat: 1.36,  lon: 103.99, country: 'SG' },
  HND: { name: 'Tokyo Haneda',  city: 'HND', lat: 35.55, lon: 139.78, country: 'JP' },
  HKG: { name: 'Hong Kong',     city: 'HKG', lat: 22.31, lon: 113.91, country: 'HK' },
  SYD: { name: 'Sydney',        city: 'SYD', lat: -33.94, lon: 151.18, country: 'AU' },
  GRU: { name: 'S\u00e3o Paulo',     city: 'GRU', lat: -23.43, lon: -46.47, country: 'BR' },
  MEX: { name: 'Mexico City',   city: 'MEX', lat: 19.44, lon: -99.07, country: 'MX' },
  YYZ: { name: 'Toronto',       city: 'YYZ', lat: 43.68, lon: -79.63, country: 'CA' },
  BOM: { name: 'Mumbai',        city: 'BOM', lat: 19.09, lon: 72.87,  country: 'IN' },
  ICN: { name: 'Seoul Incheon', city: 'ICN', lat: 37.46, lon: 126.44, country: 'KR' },
  MAD: { name: 'Madrid',        city: 'MAD', lat: 40.49, lon: -3.57,  country: 'ES' },
  IST: { name: 'Istanbul',      city: 'IST', lat: 41.26, lon: 28.74,  country: 'TR' },
};

// Curated whitelist of flights with active markets
const FLIGHTS = [
  { id: 'UA1437', carrier: 'United', from: 'SFO', to: 'JFK', dep: '08:15', arr: '16:48', date: 'May 9', risk: 0.34, premium: 12.40, payout: 180, tvl: 48200, slots: 14, threshold: 60, depTs: 'T+18h' },
  { id: 'AA118',  carrier: 'American', from: 'JFK', to: 'LAX', dep: '06:00', arr: '09:35', date: 'May 9', risk: 0.21, premium: 8.20, payout: 150, tvl: 31900, slots: 22, threshold: 60, depTs: 'T+11h' },
  { id: 'BA286',  carrier: 'British Airways', from: 'LHR', to: 'SFO', dep: '15:35', arr: '18:25', date: 'May 9', risk: 0.42, premium: 18.90, payout: 220, tvl: 92400, slots: 8, threshold: 90, depTs: 'T+22h' },
  { id: 'EK202',  carrier: 'Emirates', from: 'DXB', to: 'JFK', dep: '08:30', arr: '14:15', date: 'May 9', risk: 0.38, premium: 21.50, payout: 250, tvl: 118200, slots: 11, threshold: 90, depTs: 'T+9h' },
  { id: 'SQ22',   carrier: 'Singapore', from: 'SIN', to: 'JFK', dep: '23:55', arr: '06:00', date: 'May 9', risk: 0.29, premium: 24.80, payout: 280, tvl: 142100, slots: 6, threshold: 120, depTs: 'T+34h' },
  { id: 'LH400',  carrier: 'Lufthansa', from: 'FRA', to: 'JFK', dep: '10:25', arr: '13:25', date: 'May 9', risk: 0.31, premium: 14.10, payout: 190, tvl: 67000, slots: 18, threshold: 60, depTs: 'T+5h' },
  { id: 'AF22',   carrier: 'Air France', from: 'CDG', to: 'JFK', dep: '13:30', arr: '15:55', date: 'May 9', risk: 0.27, premium: 11.80, payout: 175, tvl: 54300, slots: 16, threshold: 60, depTs: 'T+8h' },
  { id: 'NH101',  carrier: 'ANA', from: 'HND', to: 'SFO', dep: '17:05', arr: '10:35', date: 'May 9', risk: 0.19, premium: 9.40, payout: 165, tvl: 39800, slots: 24, threshold: 60, depTs: 'T+30h' },
  { id: 'CX846',  carrier: 'Cathay', from: 'HKG', to: 'JFK', dep: '23:30', arr: '04:00', date: 'May 9', risk: 0.33, premium: 19.20, payout: 230, tvl: 88700, slots: 9, threshold: 90, depTs: 'T+33h' },
  { id: 'QF11',   carrier: 'Qantas', from: 'SYD', to: 'LAX', dep: '11:30', arr: '06:30', date: 'May 9', risk: 0.36, premium: 22.10, payout: 245, tvl: 104500, slots: 7, threshold: 90, depTs: 'T+21h' },
  { id: 'KL643',  carrier: 'KLM', from: 'AMS', to: 'JFK', dep: '14:35', arr: '16:50', date: 'May 9', risk: 0.24, premium: 10.40, payout: 168, tvl: 41600, slots: 19, threshold: 60, depTs: 'T+12h' },
  { id: 'TK11',   carrier: 'Turkish', from: 'IST', to: 'JFK', dep: '01:50', arr: '06:25', date: 'May 9', risk: 0.45, premium: 23.80, payout: 265, tvl: 78900, slots: 5, threshold: 120, depTs: 'T+4h' },
];

const VAULT_HISTORY = [
  // 30 days of APY
  9.2, 9.4, 9.1, 9.6, 10.1, 10.4, 10.2, 9.8, 9.7, 10.0,
  10.3, 10.6, 10.8, 11.0, 10.9, 11.2, 11.4, 11.1, 11.3, 11.6,
  11.8, 12.1, 11.9, 12.0, 12.3, 12.4, 12.2, 12.5, 12.7, 12.4,
];

const TVL_HISTORY = [
  3.1, 3.2, 3.3, 3.5, 3.4, 3.6, 3.8, 3.9, 4.0, 4.2,
  4.3, 4.5, 4.6, 4.8, 5.0, 5.1, 5.3, 5.4, 5.6, 5.8,
  5.9, 6.1, 6.3, 6.4, 6.6, 6.8, 6.9, 7.1, 7.3, 7.42,
];

const MY_POSITIONS = {
  active: [
    { id: 'UA1437', date: 'May 9', dep: '08:15', from: 'SFO', to: 'JFK', premium: 12.40, payout: 180, status: 'tracking', etaDelta: '+0', threshold: 60 },
    { id: 'BA286', date: 'May 11', dep: '15:35', from: 'LHR', to: 'SFO', premium: 18.90, payout: 220, status: 'tracking', etaDelta: '+22', threshold: 90 },
    { id: 'NH101', date: 'May 14', dep: '17:05', from: 'HND', to: 'SFO', premium: 9.40, payout: 165, status: 'pre-departure', etaDelta: null, threshold: 60 },
  ],
  history: [
    { id: 'AA2419', date: 'Apr 28', from: 'ORD', to: 'JFK', premium: 11.20, payout: 170, settled: 170, result: 'paid', delay: 84 },
    { id: 'DL148',  date: 'Apr 21', from: 'JFK', to: 'LHR', premium: 16.80, payout: 210, settled: 0,   result: 'expired', delay: 8 },
    { id: 'UA882',  date: 'Apr 14', from: 'SFO', to: 'NRT', premium: 22.40, payout: 260, settled: 260, result: 'paid', delay: 142 },
    { id: 'AF84',   date: 'Apr 09', from: 'SFO', to: 'CDG', premium: 19.10, payout: 235, settled: 0,   result: 'expired', delay: 0 },
    { id: 'JL5',    date: 'Mar 30', from: 'JFK', to: 'HND', premium: 24.20, payout: 280, settled: 280, result: 'paid', delay: 96 },
    { id: 'BA214',  date: 'Mar 22', from: 'LHR', to: 'BOS', premium: 12.50, payout: 175, settled: 0,   result: 'expired', delay: 14 },
    { id: 'LH441',  date: 'Mar 14', from: 'FRA', to: 'IAH', premium: 14.60, payout: 195, settled: 0,   result: 'expired', delay: 22 },
    { id: 'EK205',  date: 'Mar 02', from: 'DXB', to: 'JFK', premium: 21.40, payout: 250, settled: 250, result: 'paid', delay: 119 },
  ],
};

window.SENTINEL = { AIRPORTS, FLIGHTS, VAULT_HISTORY, TVL_HISTORY, MY_POSITIONS };
