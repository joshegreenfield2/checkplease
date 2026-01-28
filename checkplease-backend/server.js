require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fastify = require('fastify')({ logger: true });
const { parseChaseEmail, isValidTransaction } = require('./lib/chaseEmailParser');

// Enable CORS (allows requests from anywhere)
fastify.register(require('@fastify/cors'), {
  origin: true
});

// Enable multipart form parsing (for Mailgun webhooks)
fastify.register(require('@fastify/formbody'));

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
      'POST /webhooks/email-transaction': 'Receive transaction from Cloudflare Email Worker',
      'POST /webhooks/mailgun': 'Receive transaction from Mailgun inbound email',
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
  const { amount, merchant, timestamp } = request.body;

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
    timestamp: timestamp || new Date().toISOString()
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

// Email webhook endpoint - receives parsed emails from Cloudflare Email Worker
fastify.post('/webhooks/email-transaction', async (request, reply) => {
  // 1. Verify webhook secret
  const secret = request.headers['x-webhook-secret'];

  if (secret !== WEBHOOK_SECRET) {
    fastify.log.error('Invalid webhook secret for email-transaction');
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  // 2. Log the incoming email data
  fastify.log.info('📧 Received email from Cloudflare Worker:');
  fastify.log.info(`From: ${request.body.from}, To: ${request.body.to}`);

  // 3. Extract user ID from the "to" address (e.g., "user123@parse.domain.com" -> "user123")
  const { userId, from, subject, textBody, htmlBody, receivedAt } = request.body;

  if (!userId) {
    return reply.code(400).send({ error: 'Missing userId in request' });
  }

  // 4. Parse the Chase email to extract transaction data
  const parsed = parseChaseEmail({ subject, textBody, htmlBody });

  if (!isValidTransaction(parsed)) {
    fastify.log.warn(`Failed to parse transaction from email. Subject: ${subject}`);
    // Store the raw email for debugging
    const { error: logError } = await supabase
      .from('email_parse_failures')
      .insert([{
        user_id: userId,
        from_address: from,
        subject: subject,
        text_body: textBody?.substring(0, 5000),
        html_body: htmlBody?.substring(0, 10000),
        received_at: receivedAt
      }]);

    if (logError) {
      fastify.log.error('Could not log parse failure:', logError.message);
    }

    return reply.code(422).send({
      error: 'Could not parse transaction from email',
      subject: subject
    });
  }

  // 5. Create transaction object
  // Note: email_alias stores the identifier from the email address (e.g., "abc123")
  // This can later be mapped to a user_id UUID when auth is implemented
  const transaction = {
    amount: parsed.amount,
    merchant: parsed.merchant,
    timestamp: receivedAt || new Date().toISOString(),
    email_alias: userId
  };

  fastify.log.info(`Parsed transaction: $${transaction.amount} at ${transaction.merchant}`);

  // 6. Store transaction in Supabase
  const { data, error } = await supabase
    .from('transactions')
    .insert([transaction])
    .select();

  if (error) {
    fastify.log.error('Error inserting transaction into Supabase:', error);
    return reply.code(500).send({ error: 'Database error', message: error.message });
  }

  fastify.log.info('✅ Email transaction processed and saved:', data[0]);

  // 7. Return success
  return reply.code(200).send({
    success: true,
    transactionId: data[0].id,
    amount: parsed.amount,
    merchant: parsed.merchant,
    message: 'Email transaction received successfully'
  });
});

// Mailgun webhook endpoint - receives inbound emails from Mailgun
fastify.post('/webhooks/mailgun', async (request, reply) => {
  // Mailgun sends form data with these fields:
  // - recipient: email address that received the message
  // - sender: email address of the sender
  // - subject: email subject
  // - body-plain: plain text body
  // - body-html: HTML body (if available)
  // - timestamp, token, signature: for verification

  const body = request.body;

  fastify.log.info('📧 Received email from Mailgun:');
  fastify.log.info(`From: ${body.sender}, To: ${body.recipient}, Subject: ${body.subject}`);

  // Extract user ID from recipient email (e.g., "user123@sandbox.mailgun.org" -> "user123")
  const recipient = body.recipient || '';
  const userId = recipient.split('@')[0];

  if (!userId) {
    return reply.code(400).send({ error: 'Could not extract user ID from recipient' });
  }

  // Parse the Chase email
  const parsed = parseChaseEmail({
    subject: body.subject || '',
    textBody: body['body-plain'] || body['stripped-text'] || '',
    htmlBody: body['body-html'] || body['stripped-html'] || ''
  });

  if (!isValidTransaction(parsed)) {
    fastify.log.warn(`Failed to parse transaction from Mailgun email. Subject: ${body.subject}`);

    // Store for debugging
    const { error: logError } = await supabase
      .from('email_parse_failures')
      .insert([{
        user_id: userId,
        from_address: body.sender,
        subject: body.subject,
        text_body: (body['body-plain'] || '').substring(0, 5000),
        html_body: (body['body-html'] || '').substring(0, 10000),
        received_at: new Date().toISOString()
      }]);

    if (logError) {
      fastify.log.error('Could not log parse failure:', logError.message);
    }

    return reply.code(200).send({
      error: 'Could not parse transaction from email',
      subject: body.subject
    });
  }

  // Create transaction
  const transaction = {
    amount: parsed.amount,
    merchant: parsed.merchant,
    timestamp: new Date().toISOString(),
    email_alias: userId
  };

  fastify.log.info(`Parsed transaction: $${transaction.amount} at ${transaction.merchant}`);

  // Store in Supabase
  const { data, error } = await supabase
    .from('transactions')
    .insert([transaction])
    .select();

  if (error) {
    fastify.log.error('Error inserting transaction into Supabase:', error);
    return reply.code(500).send({ error: 'Database error', message: error.message });
  }

  fastify.log.info('✅ Mailgun email transaction processed:', data[0]);

  // Mailgun expects 200 OK to confirm receipt
  return reply.code(200).send({
    success: true,
    transactionId: data[0].id,
    amount: parsed.amount,
    merchant: parsed.merchant
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
