
import { DuckDBStore } from '@mastra/duckdb';

async function main() {
  const duckdb = new DuckDBStore();
  const obs = await duckdb.getStore('observability') as any;
  
  // Try to init if necessary
  if (typeof obs.init === 'function') {
      await obs.init();
  }

  try {
    const metricNames = await obs.getMetricNames();
    console.log('Metric Names:', metricNames);

    const tokenMetrics = metricNames.filter((name: string) => 
        name.toLowerCase().includes('token') || name.toLowerCase().includes('cost')
    );
    console.log('Token/Cost Metrics:', tokenMetrics);

    for (const metricName of tokenMetrics) {
        console.log(`\n--- Breakdown for ${metricName} ---`);
        try {
            // Mastra's breakdown API might be different, let's try a simple breakdown
            const breakdown = await obs.getMetricBreakdown({
                name: metricName,
            });
            console.log(JSON.stringify(breakdown, null, 2));
        } catch (e) {
            console.log(`Could not get breakdown for ${metricName}:`, (e as Error).message);
        }
    }

  } catch (err) {
    console.error('Error querying observability store:', err);
  }
}

main().catch(console.error);
