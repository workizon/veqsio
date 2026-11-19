export function baseTemplate(
  title: string,
  content: string,
  footer?: { html: string; text: string },
): { html: string; text: string } {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --brand-500: #2196F3;
      --brand-600: #1E88E5;
      --surface-0: #FFFFFF;
      --surface-1: #FAFBFC;
      --surface-3: #EBECF0;
      --text-primary: #172B4D;
      --text-secondary: #5E6C84;
      --text-inverse: #FFFFFF;
      --success: #36B37E;
      --warning: #FFAB00;
      --error: #DE350B;
    }
    body {
      margin: 0;
      padding: 0;
      background-color: var(--surface-1);
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text-primary);
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 24px;
    }
    .card {
      background: var(--surface-0);
      border: 1px solid var(--surface-3);
      border-radius: 8px;
      padding: 24px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--surface-3);
    }
    .logo {
      width: 32px;
      height: 32px;
      background: var(--brand-500);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-inverse);
      font-weight: 700;
      font-size: 14px;
    }
    .brand {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text-primary);
    }
    .content {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-secondary);
    }
    .content p {
      margin: 0 0 12px;
    }
    .meta {
      background: var(--surface-1);
      border-radius: 6px;
      padding: 16px;
      margin: 16px 0;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 13px;
      border-bottom: 1px solid var(--surface-3);
    }
    .meta-row:last-child {
      border-bottom: none;
    }
    .meta-label {
      color: var(--text-secondary);
      font-weight: 500;
    }
    .meta-value {
      color: var(--text-primary);
      font-weight: 600;
    }
    .btn {
      display: inline-block;
      background: var(--brand-500);
      color: var(--text-inverse);
      text-decoration: none;
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      margin-top: 12px;
    }
    .footer {
      text-align: center;
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="logo">P</div>
        <div class="brand">Veqsio</div>
      </div>
      <div class="title">${escapeHtml(title)}</div>
      <div class="content">
        ${content}
      </div>
    </div>
    <div class="footer">
      ${footer ? footer.html : `You are receiving this email because you are watching an issue or project in Veqsio.<br/>
      <a href="#" style="color: var(--brand-500);">Manage notification preferences</a>`}
    </div>
  </div>
</body>
</html>`;

  // Simple text extraction from HTML content for text version
  const text = `Veqsio\n\n${title}\n\n${content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n${footer ? footer.text : 'You are receiving this email because you are watching an issue or project in Veqsio.'}`;

  return { html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
