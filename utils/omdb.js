// utils/omdb.js
// Utility functions for interacting with the OMDb API.

const axios = require('axios');
const config = require('../config');
const NodeCache = require('node-cache');

const omdbApiCache = new NodeCache({ stdTTL: 86400, checkperiod: 120 }); // Cache OMDb API calls for 24 hours

const OMDB_BASE_URL = 'http://www.omdbapi.com/'; // Corrected URL: removed Markdown link formatting

/**
 * Fetches OMDb metadata for a given IMDb ID.
 * @param {string} imdbId - The IMDb ID (e.g., 'tt1234567').
 * @returns {object|null} The OMDb metadata object, or null if not found.
 */
async function getOmdbMetadata(imdbId) {
    if (!config.OMDB_API_KEY || config.OMDB_API_KEY.trim() === '' || config.OMDB_API_KEY === 'YOUR_OMDB_API_KEY_HERE') {
        console.error('OMDB_API_KEY is not configured or is the placeholder. Please set a valid OMDb API Key in config.js or as an environment variable.');
        return null;
    }

    const cacheKey = `omdb_meta_fetch_${imdbId}`;
    let cachedData = omdbApiCache.get(cacheKey);
    if (cachedData) {
        console.log(`Returning cached OMDb metadata for ${imdbId}`);
        return cachedData;
    }

    try {
        const url = `${OMDB_BASE_URL}?apikey=${config.OMDB_API_KEY}&i=${imdbId}`;
        console.log(`Fetching OMDb metadata from URL: ${url}`);
        const response = await axios.get(
            url,
            {
                headers: {
                    'User-Agent': 'Stremio-BitMagnet-Addon/1.0',
                },
                timeout: 10000, // 10 seconds timeout
            }
        );

        if (response.data.Response === 'False') {
            console.warn(`OMDb API responded with error for ${imdbId}: ${response.data.Error}`);
            return null;
        }

        omdbApiCache.set(cacheKey, response.data);
        return response.data;
    } catch (error) {
        console.error(`Error fetching OMDb metadata for ${imdbId}:`, error.message);
        if (error.response) {
            console.error('OMDb API Response Error Status:', error.response.status);
            console.error('OMDb API Response Data:', error.response.data);
            if (error.response.status === 401) {
                console.error('OMDb API Key might be invalid. Please check your OMDB_API_KEY.');
            }
        }
        return null;
    }
}

module.exports = {
    getOmdbMetadata,
};
