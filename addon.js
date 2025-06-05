// addon.js
// This file defines the core logic for the Stremio addon, including manifest,
// and implementations for catalog, meta, and stream methods.

const config = require('./config');
const { searchBitMagnet } = require('./utils/bitmagnet');
const { getTmdbMetadata, searchTmdb } = require('./utils/tmdb');
const { getTrackers } = require('./utils/trackerFetcher'); // Import the new tracker fetcher
const NodeCache = require('node-cache');

// Initialize caches
const tmdbCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // Cache TMDB responses for 1 hour
const bitMagnetCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); // Cache BitMagnet responses for 15 mins

/**
 * Generates the Stremio addon manifest.
 * @returns {object} The addon manifest object.
 */
function getManifest() {
    return {
        id: 'org.bitmagnet.stremio.addon',
        version: '1.0.0',
        name: 'BitMagnet Stremio Addon',
        description: 'Stremio addon to find and prioritize torrents from BitMagnet GraphQL API, leveraging TMDB/IMDb for metadata.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['movie', 'series'],
        catalogs: [
            {
                type: 'movie',
                id: 'bitmagnet_movies',
                name: 'BitMagnet Movies',
                extra: [
                    { name: 'search', is
                    : true },
                    { name: 'genre', isSelectable: true, options: ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'TV Movie', 'Thriller', 'War', 'Western'] }
                ]
            },
            {
                type: 'series',
                id: 'bitmagnet_series',
                name: 'BitMagnet Series',
                extra: [
                    { name: 'search', is: true },
                    { name: 'genre', isSelectable: true, options: ['Action & Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Kids', 'Mystery', 'News', 'Reality', 'Sci-Fi & Fantasy', 'Soap', 'Talk', 'War & Politics', 'Western'] }
                ]
            }
        ],
        idPrefixes: ['tt'], // Indicates support for IMDb IDs
        behaviorHints: {
            p2p: true, // Explicitly tell Stremio this addon provides P2P content.
            // This is important if you want to provide high-quality streams without excessive buffering
            // By default, Stremio will proxy streams if this is not set.
            // Setting this to true means Stremio will attempt direct P2P connection via magnet link.
            // This requires the Stremio client to have WebTorrent or a similar client integrated.
            // For details, see: [https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/stream.md](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/stream.md)
            // "bittorrent": true // This is usually applied per stream, not globally in manifest.
        }
    };
}

/**
 * Handles catalog requests.
 * Currently, it performs a TMDB search if a search query is provided,
 * otherwise, it can provide a list of popular items (placeholder for now).
 * @param {string} type - 'movie' or 'series'.
 * @param {string} id - Catalog ID (e.g., 'bitmagnet_movies').
 * @param {object} extra - Extra parameters like 'search' query.
 * @returns {object} Stremio catalog response.
 */
async function getCatalog(type, id, extra) {
    let metas = [];
    const search = extra?.search;
    const genre = extra?.genre;

    console.log(`Getting catalog for type: ${type}, id: ${id}, search: ${search}, genre: ${genre}`);

    if (search) {
        // Search TMDB first if a search query is provided
        const tmdbResults = await searchTmdb(search, type);
        for (const tmdbItem of tmdbResults) {
            metas.push({
                id: tmdbItem.imdb_id || `tt${tmdbItem.id}`, // Prefer IMDb ID if available
                type: type,
                name: tmdbItem.title || tmdbItem.name,
                poster: tmdbItem.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbItem.poster_path}` : null,
                posterShape: 'regular',
                background: tmdbItem.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbItem.backdrop_path}` : null,
                genres: tmdbItem.genres,
                releaseInfo: tmdbItem.release_date ? tmdbItem.release_date.substring(0, 4) : (tmdbItem.first_air_date ? tmdbItem.first_air_date.substring(0, 4) : ''),
            });
        }
    } else {
        // Placeholder for general catalog, e.g., popular movies/series from TMDB
        // For a real-world scenario, you'd fetch popular/trending items here.
        // For simplicity, we'll return an empty catalog if no search is provided.
        // This makes the addon primarily search-driven.
        console.log(`No search query provided for catalog ${id}. Returning empty results.`);
    }

    return { metas };
}

/**
 * Fetches detailed metadata for a specific item (movie/series).
 * @param {string} type - 'movie' or 'series'.
 * @param {string} id - IMDb ID (e.g., 'tt1234567').
 * @returns {object} Stremio meta response.
 */
async function getMeta(type, id) {
    // TMDB metadata for specific ID
    const cacheKey = `tmdb_meta_${type}_${id}`;
    let tmdbData = tmdbCache.get(cacheKey);

    if (!tmdbData) {
        tmdbData = await getTmdbMetadata(id, type);
        tmdbCache.set(cacheKey, tmdbData);
    }

    if (!tmdbData) {
        console.warn(`No TMDB metadata found for ${id}`);
        return { meta: null };
    }

    const meta = {
        id: id,
        type: type,
        name: tmdbData.title || tmdbData.name,
        poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : null,
        posterShape: 'regular',
        background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}` : null,
        description: tmdbData.overview,
        genres: tmdbData.genres ? tmdbData.genres.map(g => g.name) : [],
        releaseInfo: tmdbData.release_date ? tmdbData.release_date.substring(0, 4) : (tmdbData.first_air_date ? tmdbData.first_air_date.substring(0, 4) : ''),
        runtime: tmdbData.runtime ? `${tmdbData.runtime} min` : undefined,
        imdbRating: tmdbData.vote_average ? `${tmdbData.vote_average.toFixed(1)}/10` : undefined,
        // For series, add seasons and episodes
        videos: type === 'series' && tmdbData.seasons ? tmdbData.seasons.flatMap(season =>
            season.episodes ? season.episodes.map(episode => ({
                id: `${id}:${season.season}:${episode.episode_number}`,
                season: season.season,
                episode: episode.episode_number,
                title: episode.name,
                released: episode.air_date,
            })) : []
        ) : undefined,
    };

    return { meta };
}

/**
 * Calculates a quality score for a given torrent based on various criteria.
 * @param {object} torrentContent - The torrent content object from BitMagnet.
 * @returns {number} The calculated quality score.
 */
function calculateQualityScore(torrentContent) {
    let score = 0;
    const { torrent, videoResolution, videoCodec, videoModifier } = torrentContent;
    const torrentName = torrent.name || '';
    const seeders = torrent.seeders || 0;
    const size = torrent.size || 0; // size in bytes

    // 1. Resolution
    switch (videoResolution) {
        case 'V4320p': score += 100; break; // 8K
        case 'V2160p': score += 90; break;  // 4K
        case 'V1440p': score += 70; break;
        case 'V1080p': score += 50; break;
        case 'V720p': score += 30; break;
        case 'V576p':
        case 'V540p':
        case 'V480p':
        case 'V360p': score += 10; break;
        default: score += 0;
    }

    // 2. HDR/Dolby Vision (check torrent name and videoModifier)
    if (torrentName.match(/HDR|DV|Dolby Vision/i) || videoModifier === 'REMUX' || torrentName.match(/REMUX/i)) {
        score += 15;
    }

    // 3. Codec Quality
    switch (videoCodec) {
        case 'x265':
        case 'H265': score += 10; break;
        case 'H264': score += 5; break;
        default: score += 0;
    }

    // 4. Audio Quality (check torrent name)
    if (torrentName.match(/DTS-HD|Atmos|TrueHD|DTS/i)) {
        if (torrentName.match(/DTS-HD|Atmos/i)) {
            score += 10;
        } else if (torrentName.match(/TrueHD|DTS/i)) {
            score += 5;
        }
    }

    // 5. File Format (check torrent name)
    if (torrentName.toLowerCase().includes('.mkv')) {
        score += 5;
    }

    // 6. File Size (larger typically indicates better quality, up to a point)
    // Assuming size is in bytes. Convert to GB for scoring.
    const sizeGB = size / (1024 * 1024 * 1024);
    score += Math.min(sizeGB, 50) * 0.2; // Max 10 points for size (e.g., 50GB max score)

    // Log the score for debugging
    // console.log(`Torrent: ${torrentName}, Score: ${score}, Seeders: ${seeders}, Resolution: ${videoResolution}, Size: ${sizeGB.toFixed(2)}GB`);

    return score;
}

/**
 * Handles stream requests.
 * @param {string} type - 'movie' or 'series'.
 * @param {string} id - IMDb ID (e.g., 'tt1234567' or 'tt1234567:1:1' for series).
 * @returns {object} Stremio stream response.
 */
async function getStreams(type, id) {
    let imdbId = id;
    let season = null;
    let episode = null;

    // Dynamically import parse-torrent here to avoid ERR_PACKAGE_PATH_NOT_EXPORTED
    // parseTorrent is a default export, so we access it via .default
    const parseTorrent = (await import('parse-torrent')).default;

    // Handle series ID format (e.g., tt1234567:1:1)
    if (type === 'series') {
        const parts = id.split(':');
        if (parts.length === 3) {
            imdbId = parts[0];
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        } else {
            console.warn(`Invalid series ID format: ${id}. Expected ttXXXXXXX:S:E`);
            return { streams: [] };
        }
    }

    const cacheKey = `bitmagnet_streams_${type}_${id}`;
    let cachedStreams = bitMagnetCache.get(cacheKey);

    if (cachedStreams) {
        console.log(`Returning cached streams for ${id}`);
        return { streams: cachedStreams };
    }

    let tmdbData;
    try {
        tmdbData = await getTmdbMetadata(imdbId, type);
    } catch (error) {
        console.error(`Error fetching TMDB metadata for ${imdbId}:`, error.message);
        return { streams: [] };
    }

    if (!tmdbData) {
        console.warn(`No TMDB metadata found for ${imdbId}. Cannot search BitMagnet.`);
        return { streams: [] };
    }

    const title = tmdbData.title || tmdbData.name;
    const year = tmdbData.release_date ? parseInt(tmdbData.release_date.substring(0, 4), 10) : (tmdbData.first_air_date ? parseInt(tmdbData.first_air_date.substring(0, 4), 10) : null);

    if (!title) {
        console.warn(`Could not determine title for ${id}.`);
        return { streams: [] };
    }

    let bitMagnetResults;
    try {
        // Use title and year for BitMagnet search
        // Note: BitMagnet's GraphQL API already sorts by seeders and size,
        // which helps in getting better initial results before client-side sorting.
        bitMagnetResults = await searchBitMagnet({
            queryString: title,
            releaseYear: year,
            contentType: type === 'movie' ? 'movie' : 'tv_show',
        });
        console.log(`Found ${bitMagnetResults.length} BitMagnet results for "${title}" (${year})`);
    } catch (error) {
        console.error(`Error searching BitMagnet for ${title} (${year}):`, error.message);
        return { streams: [] };
    }

    if (!bitMagnetResults || bitMagnetResults.length === 0) {
        return { streams: [] };
    }

    // Filter results for TV shows by season and episode
    let relevantTorrents = bitMagnetResults;
    if (type === 'series' && season && episode) {
        relevantTorrents = relevantTorrents.filter(torrentContent => {
            if (!torrentContent.episodes) {
                return false;
            }
            // Check if any season/episode combination matches
            return torrentContent.episodes.seasons.some(s =>
                s.season === season && s.episodes && s.episodes.includes(episode)
            );
        });
        console.log(`Filtered to ${relevantTorrents.length} relevant torrents for S${season}E${episode}`);
    }

    if (relevantTorrents.length === 0) {
        return { streams: [] };
    }

    // Primary sort by quality score (descending), secondary sort by seeders (descending)
    relevantTorrents.sort((a, b) => {
        const scoreA = calculateQualityScore(a);
        const scoreB = calculateQualityScore(b);

        if (scoreA !== scoreB) {
            return scoreB - scoreA; // Sort by quality score first
        } else {
            // If quality scores are equal, sort by seeders
            return (b.seeders || 0) - (a.seeders || 0);
        }
    });

    // Limit results to a configurable number
    const maxStreams = parseInt(config.MAX_STREAMS_PER_ITEM, 10) || 10; // Default to 10 if not set or invalid
    const topTorrents = relevantTorrents.slice(0, maxStreams);

    // Get the dynamically fetched best public trackers
    const publicTrackers = await getTrackers();

    const streams = topTorrents.map(torrentContent => {
        const qualityDetails = [];
        if (torrentContent.videoResolution) qualityDetails.push(torrentContent.videoResolution.replace('V', ''));
        if (torrentContent.videoCodec) qualityDetails.push(torrentContent.videoCodec);
        if (torrentContent.videoModifier) qualityDetails.push(torrentContent.videoModifier);
        if (torrentContent.video3d) qualityDetails.push(torrentContent.video3d);
        if (torrentContent.languages && torrentContent.languages.length > 0) {
             qualityDetails.push(torrentContent.languages.map(lang => lang.name.toUpperCase()).join('/'));
        }

        const nameParts = [];
        if (torrentContent.torrent.name) nameParts.push(torrentContent.torrent.name);
        if (torrentContent.seeders !== undefined) nameParts.push(`S:${torrentContent.seeders}`);
        if (torrentContent.leechers !== undefined) nameParts.push(`L:${torrentContent.leechers}`);

        // Construct a user-friendly title
        let streamTitle = `${qualityDetails.join(' ')} ${torrentContent.seeders ? `(${torrentContent.seeders} Seeders)` : ''}`;
        if (type === 'series' && season && episode) {
            streamTitle = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} ${streamTitle}`;
        }
        // Ensure stream title is not empty, fallback to torrent name
        if (streamTitle.trim() === '') {
            streamTitle = torrentContent.torrent.name || 'Unknown Quality';
        }

        let parsedMagnet;
        // The infoHash from BitMagnet's GraphQL response is guaranteed to be present and reliable.
        // This is the primary source for the DHT part of the 'sources'.
        const bitmagnetInfoHash = torrentContent.infoHash;
        let dhtInfoHash = bitmagnetInfoHash ? String(bitmagnetInfoHash).toLowerCase() : '';

        let announceTrackers = []; // Trackers from the magnet URI

        try {
            // Attempt to parse magnet URI to get additional trackers that might be embedded.
            // This is secondary to the fetched public trackers and BitMagnet's infoHash.
            parsedMagnet = parseTorrent(torrentContent.torrent.magnetUri);
            if (parsedMagnet && Array.isArray(parsedMagnet.announce)) {
                announceTrackers = parsedMagnet.announce;
            } else {
                // This warning indicates the magnet URI did not contain embedded announce URLs, which is fine.
                // It means the magnet link relies on DHT or other means for initial peer discovery,
                // which will be supplemented by our `publicTrackers`.
                console.warn(`parse-torrent could not extract announce URLs from magnet URI for ${torrentContent.infoHash}. (This is often normal for some magnet links.)`);
            }
        } catch (e) {
            // Log if parsing the magnet URI throws an error, but don't halt the stream creation.
            console.error(`Error parsing magnet URI for ${torrentContent.infoHash}:`, e.message);
            // In case of error, announceTrackers remains an empty array
        }

        // Combine trackers from magnet URI and best public trackers, ensuring uniqueness
        // Convert all to 'tracker:URL' format and use a Set for uniqueness
        const allTrackers = new Set([
            ...announceTrackers.map(t => `tracker:${t}`),
            ...publicTrackers.map(t => `tracker:${t}`)
        ]);
        
        // Add DHT source if infoHash is available (it always should be from BitMagnet)
        if (dhtInfoHash) {
            allTrackers.add(`dht:${dhtInfoHash}`);
        } else {
            console.warn(`Missing infoHash for torrentContent ID: ${torrentContent.id}. DHT source will be omitted.`);
        }

        const sources = Array.from(allTrackers);

        return {
            infoHash: torrentContent.infoHash, // Always use BitMagnet's infoHash for the primary stream object
            name: nameParts.join(' | '), // This is what shows up as the torrent name in Stremio
            title: streamTitle.trim(), // This is the user-facing quality label
            type: torrentContent.contentType,
            quality: torrentContent.videoResolution ? torrentContent.videoResolution.replace('V', '') : 'Unknown',
            seeders: torrentContent.seeders,
            url: torrentContent.torrent.magnetUri,
            sources: sources, // Add the extracted and combined trackers
            behaviorHints: {
                bittorrent: true, // Explicitly tell Stremio this is a P2P torrent
                proxyHeaders: {
                    request: {
                        seedtime: 3600 // Seed for 1 hour after watching
                    }
                }
            }
        };
    });

    bitMagnetCache.set(cacheKey, streams);
    return { streams };
}

module.exports = {
    getManifest,
    getCatalog,
    getMeta,
    getStreams,
};
