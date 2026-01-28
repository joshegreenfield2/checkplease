/**
 * Chase Email Parser
 *
 * Parses Chase transaction alert emails to extract amount and merchant.
 *
 * Chase email formats vary, so we try multiple patterns:
 * 1. Subject line: "Your $XX.XX transaction at MERCHANT"
 * 2. Subject line: "Transaction alert: $XX.XX at MERCHANT"
 * 3. HTML body patterns
 */

/**
 * Parse a Chase transaction alert email
 * @param {Object} email - Email object with subject, textBody, htmlBody
 * @returns {Object|null} - { amount, merchant } or null if parsing failed
 */
function parseChaseEmail(email) {
  const { subject, textBody, htmlBody } = email;

  // Try parsing from subject first (most reliable)
  const subjectResult = parseFromSubject(subject);
  if (subjectResult) {
    return subjectResult;
  }

  // Try parsing from text body
  const textResult = parseFromTextBody(textBody);
  if (textResult) {
    return textResult;
  }

  // Try parsing from HTML body
  const htmlResult = parseFromHtmlBody(htmlBody);
  if (htmlResult) {
    return htmlResult;
  }

  return null;
}

/**
 * Parse transaction from email subject line
 */
function parseFromSubject(subject) {
  if (!subject) return null;

  // Pattern: "Your $XX.XX transaction at MERCHANT"
  const pattern1 = /Your \$([0-9,.]+) transaction at (.+)/i;
  const match1 = subject.match(pattern1);
  if (match1) {
    return {
      amount: parseAmount(match1[1]),
      merchant: cleanMerchant(match1[2])
    };
  }

  // Pattern: "Transaction alert: $XX.XX at MERCHANT"
  const pattern2 = /Transaction alert[:\s]+\$([0-9,.]+) at (.+)/i;
  const match2 = subject.match(pattern2);
  if (match2) {
    return {
      amount: parseAmount(match2[1]),
      merchant: cleanMerchant(match2[2])
    };
  }

  // Pattern: "$XX.XX at MERCHANT" (generic)
  const pattern3 = /\$([0-9,.]+)\s+(?:at|@)\s+(.+)/i;
  const match3 = subject.match(pattern3);
  if (match3) {
    return {
      amount: parseAmount(match3[1]),
      merchant: cleanMerchant(match3[2])
    };
  }

  return null;
}

/**
 * Parse transaction from plain text body
 */
function parseFromTextBody(text) {
  if (!text) return null;

  // Look for amount pattern
  const amountPatterns = [
    /Amount[:\s]+\$([0-9,.]+)/i,
    /Transaction Amount[:\s]+\$([0-9,.]+)/i,
    /Charge[:\s]+\$([0-9,.]+)/i,
    /\$([0-9,.]+)\s+was charged/i
  ];

  let amount = null;
  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (match) {
      amount = parseAmount(match[1]);
      break;
    }
  }

  // Look for merchant pattern
  const merchantPatterns = [
    /Merchant[:\s]+([^\n\r]+)/i,
    /(?:at|@)\s+([A-Z0-9][^\n\r]{2,40})/i,
    /Where[:\s]+([^\n\r]+)/i
  ];

  let merchant = null;
  for (const pattern of merchantPatterns) {
    const match = text.match(pattern);
    if (match) {
      merchant = cleanMerchant(match[1]);
      break;
    }
  }

  if (amount !== null && merchant) {
    return { amount, merchant };
  }

  return null;
}

/**
 * Parse transaction from HTML body
 */
function parseFromHtmlBody(html) {
  if (!html) return null;

  // Strip HTML tags to get text
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  return parseFromTextBody(text);
}

/**
 * Clean and parse amount string to float
 */
function parseAmount(amountStr) {
  if (!amountStr) return null;
  // Remove commas and parse
  const cleaned = amountStr.replace(/,/g, '');
  const amount = parseFloat(cleaned);
  return isNaN(amount) ? null : amount;
}

/**
 * Clean merchant name
 */
function cleanMerchant(merchant) {
  if (!merchant) return null;
  return merchant
    .trim()
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .replace(/[^\w\s&'-]/g, '') // Remove special chars except common ones
    .substring(0, 100);         // Limit length
}

/**
 * Validate that we have a valid transaction
 */
function isValidTransaction(transaction) {
  return (
    transaction &&
    typeof transaction.amount === 'number' &&
    transaction.amount > 0 &&
    typeof transaction.merchant === 'string' &&
    transaction.merchant.length > 0
  );
}

module.exports = {
  parseChaseEmail,
  parseFromSubject,
  parseFromTextBody,
  parseFromHtmlBody,
  isValidTransaction
};
