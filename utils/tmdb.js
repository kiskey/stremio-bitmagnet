// utils/tmdb.js
// Utility functions for interacting with the TMDB API.

const axios = require('axios');
const config = require('../config');
const NodeCache = require('node-cache');

const tmdbApiCache = new NodeCache({ stdTTL: 86400, checkperiod: 120 }); // Cache TMDB API calls for 24 hours

const TMDB_BASE_URL = '[https://api.themoviedb.org/3](https://api.themoviedb.org/3)';

/**
 * Fetches TMDB metadata for a given IMDb ID.
 * @param {string} imdbId - The IMDb ID (e.g., 'tt1234567').
 * @param {string} type - 'movie' or 'series'.
 * @returns {object|null} The TMDB metadata object, or null if not found.
 */
async function getTmdbMetadata(imdbId, type) {
    // Validate TMDB API Key before making any API call
    if (!config.TMDB_API_KEY || config.TMDB_API_KEY.trim() === '' || config.TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE') {
        console.error('TMDB_API_KEY is not configured or is the placeholder. Please set a valid TMDB API Key in config.js or as an environment variable.');
        return null;
    }

    const cacheKey = `tmdb_meta_fetch_${imdbId}_${type}`;
    let cachedData = tmdbApiCache.get(cacheKey);
    if (cachedData) {
        console.log(`Returning cached TMDB metadata for ${imdbId}`);
        return cachedData;
    }

    try {
        // TMDB uses 'external_ids' endpoint to find by IMDb ID
        const findUrl = `${TMDB_BASE_URL}/find/${imdbId}`;
        console.log(`Fetching TMDB metadata from URL: ${findUrl}`); // Log the URL
        const response = await axios.get(
            findUrl,
            {
                params: {
                    api_key: config.TMDB_API_KEY,
                    external_source: 'imdb_id',
                },
                headers: {
                    'User-Agent': 'Stremio-BitMagnet-Addon/1.0',
                },
                timeout: 10000, // 10 seconds timeout
            }
        );

        let data = null;
        if (type === 'movie' && response.data.movie_results && response.data.movie_results.length > 0) {
            data = response.data.movie_results[0];
            // Fetch detailed movie info for genres, runtime etc.
            const movieDetailsUrl = `${TMDB_BASE_URL}/movie/${data.id}`;
            console.log(`Fetching TMDB movie details from URL: ${movieDetailsUrl}`); // Log the URL
            const movieDetails = await axios.get(movieDetailsUrl, { params: { api_key: config.TMDB_API_KEY } });
            data = { ...data, ...movieDetails.data };
        } else if (type === 'series' && response.data.tv_results && response.data.tv_results.length > 0) {
            data = response.data.tv_results[0];
            // Fetch detailed TV info for genres, seasons, episodes etc.
            const tvDetailsUrl = `${TMDB_BASE_URL}/tv/${data.id}`;
            console.log(`Fetching TMDB TV details from URL: ${tvDetailsUrl}`); // Log the URL
            const tvDetails = await axios.get(tvDetailsUrl, { params: { api_key: config.TMDB_API_KEY } });
            data = { ...data, ...tvDetails.data };
        }

        if (data) {
            tmdbApiCache.set(cacheKey, data);
            return data;
        } else {
            console.warn(`No TMDB results found for IMDb ID: ${imdbId} and type: ${type}`);
            return null;
        }

    } catch (error) {
        console.error(`Error fetching TMDB metadata for ${imdbId}:`, error.message);
        if (error.response) {
            console.error('TMDB API Response Error Status:', error.response.status);
            console.error('TMDB API Response Data:', error.response.data);
            if (error.response.status === 401) {
                console.error('TMDB API Key might be invalid. Please check your TMDB_API_KEY.');
            } else if (error.response.status === 429) {
                console.error('TMDB API rate limit exceeded. Please wait before retrying.');
            }
        }
        return null;
    }
}

/**
 * Searches TMDB by title and type.
 * @param {string} query - The search query (title).
 * @param {string} type - 'movie' or 'series'.
 * @returns {Array<object>} An array of TMDB search results.
 */
async function searchTmdb(query, type) {
    // Validate TMDB API Key before making any API call
    if (!config.TMDB_API_KEY || config.TMDB_API_KEY.trim() === '' || config.TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE') {
        console.error('TMDB_API_KEY is not configured or is the placeholder. Please set a valid TMDB API Key in config.js or as an environment variable.');
        return [];
    }

    const cacheKey = `tmdb_search_${query}_${type}`;
    let cachedData = tmdbApiCache.get(cacheKey);
    if (cachedData) {
        console.log(`Returning cached TMDB search results for "${query}"`);
        return cachedData;
    }

    const searchPath = type === 'movie' ? 'movie' : 'tv';
    try {
        const searchUrl = `${TMDB_BASE_URL}/search/${searchPath}`;
        console.log(`Searching TMDB from URL: ${searchUrl} with query: "${query}"`); // Log the URL
        const response = await axios.get(
            searchUrl,
            {
                params: {
                    api_key: config.TMDB_API_KEY,
                    query: query,
                },
                headers: {
                    'User-Agent': 'Stremio-BitMagnet-Addon/1.0',
                },
                timeout: 10000, // 10 seconds timeout
            }
        );
        tmdbApiCache.set(cacheKey, response.data.results);
        return response.data.results;
    } catch (error) {
        console.error(`Error searching TMDB for "${query}" (${type}):`, error.message);
        if (error.response) {
            console.error('TMDB API Response Error Status:', error.response.status);
            console.error('TMDB API Response Data:', error.response.data);
            if (error.response.status === 401) {
                console.error('TMDB API Key might be invalid. Please check your TMDB_API_KEY.');
            } else if (error.response.status === 429) {
                console.error('TMDB API rate limit exceeded. Please wait before retrying.');
            }
        }
        return [];
    }
}

module.exports = {
    getTmdbMetadata,
    searchTmdb,
};
