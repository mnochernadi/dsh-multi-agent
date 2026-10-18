# Contributing to dsh-multi-agent

Thank you for your interest in improving `dsh-multi-agent`!

## Code of Conduct
Please be respectful and constructive in all discussions, issues, and pull requests.

## Development Workflow

1. Clone the repository:
   ```bash
   git clone https://github.com/mnochernadi/dsh-multi-agent.git
   cd dsh-multi-agent
   ```
2. Run the tests:
   ```bash
   npm test
   ```
3. Run the typecheck:
   ```bash
   npm install --no-audit --no-fund
   npm run typecheck
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```

## Pull Request Guidelines
- Ensure all tests pass with `npm test`.
- Ensure TypeScript passes with `npm run typecheck`.
- Keep the project zero runtime dependencies.
- Include unit tests for new functionality under `test/`.
- Maintain bilingual parity: any new user-facing strings must be added to both `fa` and `en` tables in `public/i18n.js`.
