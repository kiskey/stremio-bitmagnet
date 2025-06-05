// utils/trackerFetcher.js
// Utility to fetch and cache a list of public BitTorrent trackers from an external URL.

const axios = require('axios');
const NodeCache = require('node-cache');

// URL for the best public trackers list
const TRACKERS_LIST_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/refs/heads/master/trackers_best.txt';

// Cache for storing the fetched trackers list
// stdTTL: 86400 seconds = 24 hours. The list is updated periodically.
const trackerCache = new NodeCache({ stdTTL: 86400, checkperiod: 120 });

/**
 * Fetches the list of best public trackers from a URL and caches it.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of tracker URLs.
 */
async function getTrackers() {
    const cacheKey = 'bestPublicTrackers';
    let cachedTrackers = trackerCache.get(cacheKey);

    if (cachedTrackers) {
        console.log('Returning cached public trackers.');
        return cachedTrackers;
    }

    try {
        console.log(`Fetching public trackers from: ${TRACKERS_LIST_URL}`);
        const response = await axios.get(TRACKERS_LIST_URL, { timeout: 10000 }); // 10 seconds timeout

        // Split the response text by new lines and filter out empty lines or comments
        const trackers = response.data
            .split('\n')
            .map(line => line.trim())
            .filter(line => line !== '' && !line.startsWith('#'));

        if (trackers.length > 0) {
            trackerCache.set(cacheKey, trackers);
            console.log(`Successfully fetched and cached ${trackers.length} public trackers.`);
            return trackers;
        } else {
            console.warn('Fetched an empty or invalid trackers list. Returning empty array.');
            return [];
        }
    } catch (error) {
        console.error('Error fetching public trackers:', error.message);
        if (error.response) {
            console.error('Tracker Fetch API Response Error Status:', error.response.status);
            console.error('Tracker Fetch API Response Data:', error.response.data);
        }
        // Return empty array on failure to prevent app crash
        return [];
    }
}

module.exports = {
    getTrackers
};
