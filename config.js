// config.js
// Configuration variables for the addon, loaded from environment variables.

module.exports = {
    BITMAGNET_GRAPHQL_ENDPOINT: process.env.BITMAGNET_GRAPHQL_ENDPOINT || 'https://b.mjlan.duckdns.org/graphql',
    TMDB_API_KEY: process.env.TMDB_API_KEY || 'YOUR_TMDB_API_KEY_HERE', // IMPORTANT: Replace with a real TMDB API Key
    OMDB_API_KEY: process.env.OMDB_API_KEY || 'YOUR_OMDB_API_KEY_HERE', // IMPORTANT: Add your OMDb API Key here
    // Note: In a production Docker setup, this should always be set via environment variables.

    MAX_STREAMS_PER_ITEM: process.env.MAX_STREAMS_PER_ITEM || '10', // Max number of streams to return per item, configurable
};
