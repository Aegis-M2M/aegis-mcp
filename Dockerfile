# aegis-cli/Dockerfile

FROM node:20-slim

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the source code
COPY . .

# Expose the daemon port
EXPOSE 23447

# The docker-compose.yml overrides this anyway, 
# but it is good practice to have a default command.
CMD ["npx", "tsx", "src/cli.ts", "start", "--port", "23447"]