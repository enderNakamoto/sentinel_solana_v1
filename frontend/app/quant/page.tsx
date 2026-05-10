import MonteCarloSimulator from '@/components/MonteCarloSimulator';

export const metadata = {
  title: 'Quantitative Analysis · Sentinel',
  description:
    'Monte Carlo simulation for Sentinel underwriter yield + protocol earnings.',
};

export default function QuantPage() {
  return <MonteCarloSimulator showHero />;
}
