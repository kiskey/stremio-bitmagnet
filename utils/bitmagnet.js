// utils/bitmagnet.js
// Utility functions for interacting with the BitMagnet GraphQL API.

const axios = require('axios');
const config = require('../config');

// GraphQL query for torrent content search
const BITMAGNET_SEARCH_QUERY = `
fragment TorrentContentFields on TorrentContent {
  id
  infoHash
  contentType
  title
  languages {
    id
    name
  }
  episodes {
    label
    seasons {
      season
      episodes
    }
  }
  video3d
  videoCodec
  videoModifier
  videoResolution
  videoSource
  releaseGroup
  seeders
  leechers
  publishedAt
  torrent {
    name
    size
    fileType
    tagNames
    magnetUri
  }
  content {
    source
    id
    title
    releaseYear
    runtime
    overview
    externalLinks {
      url
    }
    originalLanguage {
      id
      name
    }
  }
}

query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
  torrentContent {
    search(input: $input) {
      items {
        ...TorrentContentFields
      }
      totalCount
      hasNextPage
    }
  }
}
`;

/**
 * Sanitizes a title string by removing special characters and extra spaces.
 * @param {string} title - The title string to sanitize.
 * @returns {string} The sanitized title.
 */
function sanitizeTitle(title) {
    if (!title) return '';
    // Remove characters that are not alphanumeric, spaces, or hyphens/underscores
    // Also remove common release group tags or year in parentheses/brackets
    // And replace multiple spaces with a single space
    return title
        .replace(/(\(|\)|\[|\]|\{|\}|'|"|\.|,|-|_|!|\?|\/|:|;|\(|\)|\&)/g, ' ') // Replace common special chars with space
        .replace(/\s+/g, ' ') // Replace multiple spaces with a single space
        .trim(); // Trim leading/trailing spaces
}

/**
 * Searches the BitMagnet GraphQL API for torrent content.
 * @param {object} params - Search parameters.
 * @param {string} params.queryString - The search query string (e.g., movie title).
 * @param {string} [params.contentType] - 'movie' or 'tv_show'.
 * @param {number} [params.releaseYear] - Release year.
 * @returns {Array<object>} An array of torrent content objects.
 */
async function searchBitMagnet({ queryString, contentType, releaseYear }) {
    if (!config.BITMAGNET_GRAPHQL_ENDPOINT) {
        console.error('BITMAGNET_GRAPHQL_ENDPOINT is not configured.');
        return [];
    }

    // Sanitized query string for BitMagnet
    const sanitizedQueryString = sanitizeTitle(queryString);

    const variables = {
        input: {
            queryString: sanitizedQueryString,
            limit: 50, // Fetch more than 10 to allow for client-side filtering/sorting
            orderBy: [
                { field: 'seeders', descending: true },
                { field: 'size', descending: true }
            ],
            facets: {
                contentType: { filter: contentType ? [contentType] : [] },
            },
            cached: true // Explicitly request cached results from BitMagnet if available
        }
    };

    // Conditionally add releaseYear to facets if it's provided and valid
    if (releaseYear !== null && !isNaN(releaseYear)) {
        variables.input.facets.releaseYear = { filter: [String(releaseYear)] };
    }

    try {
        console.log('Sending GraphQL query to BitMagnet with variables:', JSON.stringify(variables, null, 2)); // Log full payload
        const response = await axios.post(
            config.BITMAGNET_GRAPHQL_ENDPOINT,
            {
                query: BITMAGNET_SEARCH_QUERY,
                variables: variables,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Stremio-BitMagnet-Addon/1.0', // Custom User-Agent
                },
                timeout: 15000, // 15 seconds timeout
            }
        );

        if (response.data.errors) {
            console.error('BitMagnet GraphQL errors:', response.data.errors);
            return [];
        }

        return response.data.data.torrentContent.search.items || [];
    } catch (error) {
        console.error('Error searching BitMagnet:', error.message);
        if (error.response) {
            console.error('BitMagnet API Response Error:', error.response.status, error.response.data);
        }
        return [];
    }
}

module.exports = {
    searchBitMagnet,
};
