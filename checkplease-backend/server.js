require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fastify = require('fastify')({ logger: true });

// Enable CORS (allows requests from anywhere)
fastify.register(require('@fastify/cors'), {
  origin: true
});

// App configuration
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key-change-this';
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Root endpoint - shows available routes
fastify.get('/', async (request, reply) => {
  return {
    name: 'Check Please API',
    endpoints: {
      'GET /health': 'Health check',
      'POST /webhooks/transaction': 'Receive transaction from Make.com',
      'GET /transactions': 'Get all transactions',
      'GET /transactions/latest': 'Get latest transaction'
    }
  };
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Main webhook endpoint that Make will call
fastify.post('/webhooks/transaction', async (request, reply) => {
  // 1. Verify webhook secret
  const secret = request.headers['x-webhook-secret'];

  if (secret !== WEBHOOK_SECRET) {
    fastify.log.error('Invalid webhook secret');
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  // 2. Log the incoming data
  fastify.log.info('📧 Received transaction from Make:');
  fastify.log.info(JSON.stringify(request.body, null, 2));

  // 3. Extract transaction data
  const { amount, merchant, timestamp, cardLast4, rawEmail } = request.body;

  // 4. Validate required fields
  if (!amount || !merchant) {
    return reply.code(400).send({
      error: 'Missing required fields: amount and merchant'
    });
  }

  // 5. Create transaction object
  const transaction = {
    amount: parseFloat(amount),
    merchant: merchant,
    timestamp: timestamp || new Date().toISOString(),
    cardLast4: cardLast4 || 'xxxx',
    rawEmail: rawEmail || null,
    receivedAt: new Date().toISOString()
  };

  // 6. Store transaction in Supabase
  const { data, error } = await supabase
    .from('transactions')
    .insert([transaction])
    .select();

  if (error) {
    fastify.log.error('Error inserting transaction into Supabase:', error);
    return reply.code(500).send({ error: 'Database error', message: error.message });
  }

  fastify.log.info('✅ Transaction processed and saved to Supabase:', data[0]);

  // 7. Return success
  return reply.code(200).send({
    success: true,
    transactionId: data[0].id,
    message: 'Transaction received successfully'
  });
});

// Endpoint for app to fetch all transactions
fastify.get('/transactions', async (request, reply) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false });

  if (error) {
    fastify.log.error('Error fetching transactions from Supabase:', error);
    return reply.code(500).send({ error: 'Database error' });
  }

  return reply.send(data);
});

// Endpoint for app to fetch latest transaction
fastify.get('/transactions/latest', async (request, reply) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(1);

  if (error) {
    fastify.log.error('Error fetching latest transaction from Supabase:', error);
    return reply.code(500).send({ error: 'Database error' });
  }

  if (!data || data.length === 0) {
    return reply.code(404).send({
      error: 'No transactions yet'
    });
  }

  return reply.send(data[0]);
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📍 Webhook endpoint: http://localhost:${PORT}/webhooks/transaction`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
