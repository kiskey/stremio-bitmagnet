# Dockerfile
# Use a lightweight Node.js base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if exists)
# to leverage Docker caching for dependencies
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 7000

# Command to run the application
CMD ["node", "index.js"]
