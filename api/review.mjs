export default function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  return response.status(503).json({
    error: 'The hosted viewer supports manual review. For AI review, run the local server with a configured imaging model.'
  });
}
