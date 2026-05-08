/**
 * Mock data — ported from design_system/data.jsx.
 * Phase 12 is the only place this is the source of truth. Phases 13–15
 * swap the consuming functions in src/data/index.ts to read from chain
 * one at a time; this file becomes the "fallback / development" data.
 */

import type {
  Airport,
  MarketView,
  MyPolicies,
  ProtocolStats,
  VaultStats,
} from './types';

export const MOCK_AIRPORTS: Record<string, Airport> = {
  SFO: { code: 'SFO', name: 'San Francisco', city: 'SFO', lat: 37.62, lon: -122.38, country: 'US' },
  JFK: { code: 'JFK', name: 'New York JFK', city: 'JFK', lat: 40.64, lon: -73.78, country: 'US' },
  EWR: { code: 'EWR', name: 'Newark Liberty', city: 'EWR', lat: 40.69, lon: -74.17, country: 'US' },
  LGA: { code: 'LGA', name: 'New York LaGuardia', city: 'LGA', lat: 40.78, lon: -73.87, country: 'US' },
  LAX: { code: 'LAX', name: 'Los Angeles', city: 'LAX', lat: 33.94, lon: -118.40, country: 'US' },
  SEA: { code: 'SEA', name: 'Seattle-Tacoma', city: 'SEA', lat: 47.45, lon: -122.31, country: 'US' },
  MIA: { code: 'MIA', name: 'Miami', city: 'MIA', lat: 25.79, lon: -80.29, country: 'US' },
  ORD: { code: 'ORD', name: "Chicago O'Hare", city: 'ORD', lat: 41.97, lon: -87.91, country: 'US' },
  ATL: { code: 'ATL', name: 'Atlanta', city: 'ATL', lat: 33.64, lon: -84.43, country: 'US' },
  DFW: { code: 'DFW', name: 'Dallas-Fort Worth', city: 'DFW', lat: 32.90, lon: -97.04, country: 'US' },
  LHR: { code: 'LHR', name: 'London Heathrow', city: 'LHR', lat: 51.47, lon: -0.45, country: 'UK' },
  CDG: { code: 'CDG', name: 'Paris Charles de Gaulle', city: 'CDG', lat: 49.01, lon: 2.55, country: 'FR' },
  FRA: { code: 'FRA', name: 'Frankfurt', city: 'FRA', lat: 50.04, lon: 8.56, country: 'DE' },
  AMS: { code: 'AMS', name: 'Amsterdam', city: 'AMS', lat: 52.31, lon: 4.76, country: 'NL' },
  DXB: { code: 'DXB', name: 'Dubai', city: 'DXB', lat: 25.25, lon: 55.36, country: 'AE' },
  SIN: { code: 'SIN', name: 'Singapore', city: 'SIN', lat: 1.36, lon: 103.99, country: 'SG' },
  HND: { code: 'HND', name: 'Tokyo Haneda', city: 'HND', lat: 35.55, lon: 139.78, country: 'JP' },
  HKG: { code: 'HKG', name: 'Hong Kong', city: 'HKG', lat: 22.31, lon: 113.91, country: 'HK' },
  SYD: { code: 'SYD', name: 'Sydney', city: 'SYD', lat: -33.94, lon: 151.18, country: 'AU' },
  GRU: { code: 'GRU', name: 'São Paulo', city: 'GRU', lat: -23.43, lon: -46.47, country: 'BR' },
  MEX: { code: 'MEX', name: 'Mexico City', city: 'MEX', lat: 19.44, lon: -99.07, country: 'MX' },
  YYZ: { code: 'YYZ', name: 'Toronto', city: 'YYZ', lat: 43.68, lon: -79.63, country: 'CA' },
  BOM: { code: 'BOM', name: 'Mumbai', city: 'BOM', lat: 19.09, lon: 72.87, country: 'IN' },
  ICN: { code: 'ICN', name: 'Seoul Incheon', city: 'ICN', lat: 37.46, lon: 126.44, country: 'KR' },
  MAD: { code: 'MAD', name: 'Madrid', city: 'MAD', lat: 40.49, lon: -3.57, country: 'ES' },
  IST: { code: 'IST', name: 'Istanbul', city: 'IST', lat: 41.26, lon: 28.74, country: 'TR' },
};

export const MOCK_FLIGHTS: MarketView[] = [
  { id: 'UA230',  carrier: 'United',   from: 'EWR', to: 'SEA', dep: '08:30', arr: '11:45', date: 'May 9',  risk: 0.32, premium: 14.20, payout: 195, tvl: 62300,  slots: 18, threshold: 60,  depTs: 'T+12h' },
  { id: 'UA247',  carrier: 'United',   from: 'EWR', to: 'SEA', dep: '17:20', arr: '20:35', date: 'May 9',  risk: 0.34, premium: 14.80, payout: 200, tvl: 58900,  slots: 12, threshold: 60,  depTs: 'T+21h' },
  { id: 'AS280',  carrier: 'Alaska',   from: 'EWR', to: 'SEA', dep: '07:55', arr: '11:10', date: 'May 10', risk: 0.28, premium: 13.40, payout: 185, tvl: 71200,  slots: 16, threshold: 60,  depTs: 'T+34h' },
  { id: 'AS359',  carrier: 'Alaska',   from: 'EWR', to: 'SEA', dep: '15:40', arr: '18:55', date: 'May 10', risk: 0.30, premium: 13.90, payout: 190, tvl: 64100,  slots: 14, threshold: 60,  depTs: 'T+42h' },
  { id: 'UA2037', carrier: 'United',   from: 'EWR', to: 'SFO', dep: '09:15', arr: '12:48', date: 'May 9',  risk: 0.31, premium: 14.50, payout: 195, tvl: 78400,  slots: 20, threshold: 60,  depTs: 'T+13h' },
  { id: 'UA2214', carrier: 'United',   from: 'EWR', to: 'SFO', dep: '18:45', arr: '22:18', date: 'May 9',  risk: 0.36, premium: 15.80, payout: 215, tvl: 91200,  slots: 9,  threshold: 90,  depTs: 'T+22h' },
  { id: 'UA1745', carrier: 'United',   from: 'EWR', to: 'LAX', dep: '10:20', arr: '13:50', date: 'May 9',  risk: 0.27, premium: 12.80, payout: 175, tvl: 54200,  slots: 22, threshold: 60,  depTs: 'T+14h' },
  { id: 'UA1229', carrier: 'United',   from: 'EWR', to: 'LAX', dep: '19:10', arr: '22:40', date: 'May 9',  risk: 0.33, premium: 14.40, payout: 195, tvl: 67800,  slots: 11, threshold: 60,  depTs: 'T+23h' },
  { id: 'UA2125', carrier: 'United',   from: 'EWR', to: 'DFW', dep: '07:40', arr: '10:35', date: 'May 9',  risk: 0.25, premium: 11.20, payout: 165, tvl: 41800,  slots: 24, threshold: 60,  depTs: 'T+11h' },
  { id: 'AA2391', carrier: 'American', from: 'EWR', to: 'DFW', dep: '14:50', arr: '17:45', date: 'May 9',  risk: 0.29, premium: 12.40, payout: 175, tvl: 47600,  slots: 16, threshold: 60,  depTs: 'T+18h' },
  { id: 'UA1914', carrier: 'United',   from: 'EWR', to: 'MIA', dep: '09:00', arr: '12:15', date: 'May 9',  risk: 0.22, premium: 9.80,  payout: 155, tvl: 35400,  slots: 26, threshold: 60,  depTs: 'T+13h' },
  { id: 'AA1065', carrier: 'American', from: 'EWR', to: 'MIA', dep: '16:30', arr: '19:45', date: 'May 9',  risk: 0.26, premium: 10.90, payout: 165, tvl: 39200,  slots: 19, threshold: 60,  depTs: 'T+20h' },
  { id: 'DL1374', carrier: 'Delta',    from: 'LGA', to: 'MIA', dep: '08:15', arr: '11:30', date: 'May 9',  risk: 0.24, premium: 10.40, payout: 160, tvl: 38900,  slots: 22, threshold: 60,  depTs: 'T+12h' },
  { id: 'AA605',  carrier: 'American', from: 'LGA', to: 'MIA', dep: '11:50', arr: '15:05', date: 'May 9',  risk: 0.21, premium: 9.60,  payout: 155, tvl: 33600,  slots: 24, threshold: 60,  depTs: 'T+15h' },
  { id: 'AA716',  carrier: 'American', from: 'LGA', to: 'MIA', dep: '14:20', arr: '17:35', date: 'May 9',  risk: 0.27, premium: 10.80, payout: 165, tvl: 36100,  slots: 18, threshold: 60,  depTs: 'T+18h' },
  { id: 'AA845',  carrier: 'American', from: 'LGA', to: 'MIA', dep: '18:00', arr: '21:15', date: 'May 9',  risk: 0.31, premium: 12.20, payout: 175, tvl: 42400,  slots: 13, threshold: 60,  depTs: 'T+22h' },
  { id: 'DL2345', carrier: 'Delta',    from: 'LGA', to: 'DFW', dep: '07:30', arr: '10:25', date: 'May 9',  risk: 0.23, premium: 10.20, payout: 160, tvl: 36800,  slots: 21, threshold: 60,  depTs: 'T+11h' },
  { id: 'AA1222', carrier: 'American', from: 'LGA', to: 'DFW', dep: '12:40', arr: '15:35', date: 'May 9',  risk: 0.28, premium: 11.40, payout: 170, tvl: 41200,  slots: 17, threshold: 60,  depTs: 'T+16h' },
  { id: 'AA1268', carrier: 'American', from: 'LGA', to: 'DFW', dep: '17:15', arr: '20:10', date: 'May 9',  risk: 0.32, premium: 12.80, payout: 180, tvl: 45800,  slots: 12, threshold: 60,  depTs: 'T+21h' },
  { id: 'DL1987', carrier: 'Delta',    from: 'LGA', to: 'ORD', dep: '09:45', arr: '11:30', date: 'May 9',  risk: 0.34, premium: 11.60, payout: 170, tvl: 39400,  slots: 20, threshold: 60,  depTs: 'T+13h' },
  { id: 'AA300',  carrier: 'American', from: 'JFK', to: 'LAX', dep: '06:00', arr: '09:35', date: 'May 9',  risk: 0.21, premium: 8.20,  payout: 150, tvl: 31900,  slots: 22, threshold: 60,  depTs: 'T+10h' },
  { id: 'DL567',  carrier: 'Delta',    from: 'JFK', to: 'LAX', dep: '11:30', arr: '15:05', date: 'May 9',  risk: 0.26, premium: 10.40, payout: 165, tvl: 38700,  slots: 18, threshold: 60,  depTs: 'T+15h' },
  { id: 'B6203',  carrier: 'JetBlue',  from: 'JFK', to: 'LAX', dep: '17:00', arr: '20:35', date: 'May 9',  risk: 0.30, premium: 11.80, payout: 175, tvl: 44200,  slots: 14, threshold: 60,  depTs: 'T+21h' },
  { id: 'AS15',   carrier: 'Alaska',   from: 'JFK', to: 'SEA', dep: '08:50', arr: '12:25', date: 'May 9',  risk: 0.28, premium: 12.60, payout: 180, tvl: 49100,  slots: 16, threshold: 60,  depTs: 'T+12h' },
  { id: 'DL289',  carrier: 'Delta',    from: 'JFK', to: 'SEA', dep: '15:30', arr: '19:05', date: 'May 9',  risk: 0.32, premium: 13.80, payout: 190, tvl: 53600,  slots: 11, threshold: 60,  depTs: 'T+19h' },
  { id: 'AA1775', carrier: 'American', from: 'JFK', to: 'SEA', dep: '20:10', arr: '23:45', date: 'May 9',  risk: 0.36, premium: 14.90, payout: 200, tvl: 56400,  slots: 8,  threshold: 90,  depTs: 'T+24h' },
  { id: 'UA415',  carrier: 'United',   from: 'EWR', to: 'SFO', dep: '06:25', arr: '09:58', date: 'May 10', risk: 0.24, premium: 11.20, payout: 170, tvl: 42800,  slots: 23, threshold: 60,  depTs: 'T+34h' },
  { id: 'UA549',  carrier: 'United',   from: 'EWR', to: 'SFO', dep: '13:40', arr: '17:13', date: 'May 10', risk: 0.29, premium: 13.10, payout: 185, tvl: 51200,  slots: 17, threshold: 60,  depTs: 'T+41h' },
  { id: 'AS20',   carrier: 'Alaska',   from: 'SEA', to: 'EWR', dep: '08:15', arr: '16:30', date: 'May 10', risk: 0.31, premium: 13.40, payout: 190, tvl: 48900,  slots: 15, threshold: 60,  depTs: 'T+36h' },
  { id: 'UA1558', carrier: 'United',   from: 'SEA', to: 'EWR', dep: '22:45', arr: '06:55', date: 'May 11', risk: 0.38, premium: 16.20, payout: 220, tvl: 62100,  slots: 7,  threshold: 90,  depTs: 'T+50h' },
  { id: 'AA970',  carrier: 'American', from: 'LGA', to: 'MIA', dep: '06:30', arr: '09:45', date: 'May 10', risk: 0.20, premium: 9.20,  payout: 155, tvl: 32100,  slots: 25, threshold: 60,  depTs: 'T+34h' },
  { id: 'DL2450', carrier: 'Delta',    from: 'LGA', to: 'ATL', dep: '10:50', arr: '13:35', date: 'May 10', risk: 0.26, premium: 10.40, payout: 165, tvl: 36800,  slots: 19, threshold: 60,  depTs: 'T+38h' },
  { id: 'AA1249', carrier: 'American', from: 'LGA', to: 'MIA', dep: '20:30', arr: '23:45', date: 'May 10', risk: 0.34, premium: 13.60, payout: 185, tvl: 48400,  slots: 10, threshold: 60,  depTs: 'T+48h' },
  { id: 'UA752',  carrier: 'United',   from: 'SFO', to: 'EWR', dep: '07:30', arr: '15:55', date: 'May 10', risk: 0.27, premium: 12.40, payout: 180, tvl: 47200,  slots: 19, threshold: 60,  depTs: 'T+35h' },
  { id: 'UA2248', carrier: 'United',   from: 'SFO', to: 'EWR', dep: '21:50', arr: '06:15', date: 'May 11', risk: 0.39, premium: 16.80, payout: 225, tvl: 64300,  slots: 6,  threshold: 90,  depTs: 'T+49h' },
  { id: 'AS11',   carrier: 'Alaska',   from: 'SEA', to: 'JFK', dep: '09:20', arr: '17:35', date: 'May 10', risk: 0.30, premium: 13.20, payout: 185, tvl: 47800,  slots: 14, threshold: 60,  depTs: 'T+37h' },
  { id: 'DL490',  carrier: 'Delta',    from: 'SEA', to: 'JFK', dep: '14:00', arr: '22:15', date: 'May 10', risk: 0.33, premium: 14.20, payout: 195, tvl: 53100,  slots: 11, threshold: 60,  depTs: 'T+42h' },
  { id: 'AA1192', carrier: 'American', from: 'DFW', to: 'LGA', dep: '08:45', arr: '13:25', date: 'May 10', risk: 0.25, premium: 11.10, payout: 170, tvl: 39800,  slots: 21, threshold: 60,  depTs: 'T+36h' },
  { id: 'AA2751', carrier: 'American', from: 'DFW', to: 'LGA', dep: '15:20', arr: '20:00', date: 'May 10', risk: 0.31, premium: 12.80, payout: 180, tvl: 44600,  slots: 13, threshold: 60,  depTs: 'T+43h' },
  { id: 'AA2401', carrier: 'American', from: 'DFW', to: 'EWR', dep: '11:10', arr: '15:55', date: 'May 10', risk: 0.28, premium: 11.90, payout: 175, tvl: 41200,  slots: 17, threshold: 60,  depTs: 'T+39h' },
  { id: 'AA1298', carrier: 'American', from: 'MIA', to: 'LGA', dep: '07:00', arr: '10:15', date: 'May 10', risk: 0.22, premium: 9.40,  payout: 155, tvl: 34200,  slots: 23, threshold: 60,  depTs: 'T+35h' },
  { id: 'DL1124', carrier: 'Delta',    from: 'MIA', to: 'LGA', dep: '13:30', arr: '16:45', date: 'May 10', risk: 0.27, premium: 11.20, payout: 170, tvl: 40100,  slots: 18, threshold: 60,  depTs: 'T+41h' },
  { id: 'UA1161', carrier: 'United',   from: 'LAX', to: 'EWR', dep: '08:25', arr: '16:50', date: 'May 10', risk: 0.29, premium: 12.40, payout: 180, tvl: 46800,  slots: 16, threshold: 60,  depTs: 'T+36h' },
  { id: 'UA2265', carrier: 'United',   from: 'LAX', to: 'EWR', dep: '23:30', arr: '07:55', date: 'May 11', risk: 0.41, premium: 17.60, payout: 235, tvl: 71200,  slots: 5,  threshold: 90,  depTs: 'T+51h' },
  { id: 'DL456',  carrier: 'Delta',    from: 'LAX', to: 'JFK', dep: '14:15', arr: '22:30', date: 'May 10', risk: 0.32, premium: 13.40, payout: 190, tvl: 49800,  slots: 12, threshold: 60,  depTs: 'T+42h' },
  { id: 'AA1',    carrier: 'American', from: 'JFK', to: 'LAX', dep: '08:30', arr: '12:05', date: 'May 11', risk: 0.23, premium: 10.80, payout: 165, tvl: 51300,  slots: 20, threshold: 60,  depTs: 'T+60h' },
  { id: 'UA521',  carrier: 'United',   from: 'SFO', to: 'EWR', dep: '11:45', arr: '20:10', date: 'May 11', risk: 0.30, premium: 13.20, payout: 185, tvl: 49600,  slots: 14, threshold: 60,  depTs: 'T+63h' },
  { id: 'AA1845', carrier: 'American', from: 'MIA', to: 'JFK', dep: '09:30', arr: '12:45', date: 'May 11', risk: 0.25, premium: 10.40, payout: 165, tvl: 38400,  slots: 19, threshold: 60,  depTs: 'T+61h' },
  { id: 'DL517',  carrier: 'Delta',    from: 'SEA', to: 'LAX', dep: '07:15', arr: '09:55', date: 'May 11', risk: 0.21, premium: 8.80,  payout: 150, tvl: 30200,  slots: 24, threshold: 60,  depTs: 'T+59h' },
  { id: 'AS331',  carrier: 'Alaska',   from: 'SEA', to: 'SFO', dep: '15:40', arr: '17:55', date: 'May 11', risk: 0.19, premium: 8.40,  payout: 145, tvl: 28900,  slots: 25, threshold: 60,  depTs: 'T+67h' },
];

export const MOCK_TVL_HISTORY = [
  3.1, 3.2, 3.3, 3.5, 3.4, 3.6, 3.8, 3.9, 4.0, 4.2,
  4.3, 4.5, 4.6, 4.8, 5.0, 5.1, 5.3, 5.4, 5.6, 5.8,
  5.9, 6.1, 6.3, 6.4, 6.6, 6.8, 6.9, 7.1, 7.3, 7.42,
];

export const MOCK_VAULT_HISTORY = [
  9.2, 9.4, 9.1, 9.6, 10.1, 10.4, 10.2, 9.8, 9.7, 10.0,
  10.3, 10.6, 10.8, 11.0, 10.9, 11.2, 11.4, 11.1, 11.3, 11.6,
  11.8, 12.1, 11.9, 12.0, 12.3, 12.4, 12.2, 12.5, 12.7, 12.4,
];

export const MOCK_PROTOCOL_STATS: ProtocolStats = {
  tvl: 7_420_000,
  tvl24hChange: 87_420,
  apy: 12.4,
  apy7dChange: 0.3,
  openMarkets: 142,
  carriers: 24,
  avgPayoutSpeedSec: 6.2,
  tvlHistory: MOCK_TVL_HISTORY,
  apyHistory: MOCK_VAULT_HISTORY,
};

export const MOCK_VAULT_STATS: VaultStats = {
  tvl: 7_423_108,
  tvlChange24h: 87_420,
  utilization: 0.64,
  apy: 12.4,
  tiers: [
    { id: 'conservative', label: 'Conservative', apy: 7.8, maxDrawdown: 0.2, description: 'Only writes coverage on flights with <20% delay odds. Lowest variance.', accentVar: '--cyan' },
    { id: 'balanced', label: 'Balanced', apy: 12.4, maxDrawdown: 0.8, description: 'Default mix across all whitelisted markets. Best risk-adjusted return.', accentVar: '--amber' },
    { id: 'aggressive', label: 'Aggressive', apy: 21.7, maxDrawdown: 3.6, description: 'Concentrated on high-premium / high-risk routes. Larger drawdowns.', accentVar: '--violet' },
  ],
  composition: [
    { label: 'North America', pct: 38, colorVar: 'var(--cyan)' },
    { label: 'Transatlantic', pct: 24, colorVar: 'var(--amber)' },
    { label: 'Asia-Pacific', pct: 18, colorVar: 'var(--violet)' },
    { label: 'Intra-Europe', pct: 12, colorVar: 'var(--green)' },
    { label: 'Other', pct: 8, colorVar: 'var(--red)' },
  ],
  myPosition: {
    deposited: 2400,
    earned: 148.32,
    activeCoverage: 1536,
  },
};

export const MOCK_MY_POLICIES: MyPolicies = {
  active: [
    { id: 'UA1437', date: 'May 9', dep: '08:15', from: 'SFO', to: 'JFK', premium: 12.40, payout: 180, status: 'tracking', etaDelta: 0, threshold: 60 },
    { id: 'BA286', date: 'May 11', dep: '15:35', from: 'LHR', to: 'SFO', premium: 18.90, payout: 220, status: 'tracking', etaDelta: 22, threshold: 90 },
    { id: 'NH101', date: 'May 14', dep: '17:05', from: 'HND', to: 'SFO', premium: 9.40, payout: 165, status: 'pre-departure', etaDelta: null, threshold: 60 },
  ],
  history: [
    { id: 'AA2419', date: 'Apr 28', from: 'ORD', to: 'JFK', premium: 11.20, payout: 170, settled: 170, result: 'paid', delay: 84 },
    { id: 'DL148', date: 'Apr 21', from: 'JFK', to: 'LHR', premium: 16.80, payout: 210, settled: 0, result: 'expired', delay: 8 },
    { id: 'UA882', date: 'Apr 14', from: 'SFO', to: 'NRT', premium: 22.40, payout: 260, settled: 260, result: 'paid', delay: 142 },
    { id: 'AF84', date: 'Apr 09', from: 'SFO', to: 'CDG', premium: 19.10, payout: 235, settled: 0, result: 'expired', delay: 0 },
    { id: 'JL5', date: 'Mar 30', from: 'JFK', to: 'HND', premium: 24.20, payout: 280, settled: 280, result: 'paid', delay: 96 },
    { id: 'BA214', date: 'Mar 22', from: 'LHR', to: 'BOS', premium: 12.50, payout: 175, settled: 0, result: 'expired', delay: 14 },
    { id: 'LH441', date: 'Mar 14', from: 'FRA', to: 'IAH', premium: 14.60, payout: 195, settled: 0, result: 'expired', delay: 22 },
    { id: 'EK205', date: 'Mar 02', from: 'DXB', to: 'JFK', premium: 21.40, payout: 250, settled: 250, result: 'paid', delay: 119 },
  ],
};
