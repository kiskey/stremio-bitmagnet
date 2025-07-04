// addon.js
// This file defines the core logic for the Stremio addon, including manifest,
// and implementations for catalog, meta, and stream methods.

const config = require('./config');
const { searchBitMagnet } = require('./utils/bitmagnet');
const { getTmdbMetadata, searchTmdb } = require('./utils/tmdb');
const { getOmdbMetadata } = require('./utils/omdb'); // Import the new OMDb utility
const { getTrackers } = require('./utils/trackerFetcher'); // Import the new tracker fetcher
const NodeCache = require('node-cache');

// Initialize caches
const tmdbCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // Cache combined metadata responses for 1 hour
const bitMagnetCache = new NodeCache({ stdTTL: 900, checkperiod: 60 }); // Cache BitMagnet responses for 15 mins

/**
 * Generates the Stremio addon manifest.
 * @returns {object} The addon manifest object.
 */
function getManifest() {
    return {
        id: 'org.bitmagnet.stremio.addon',
        version: '4.0.1', // Updated version to 4.0.1
        name: 'BitMagnet Stremio Addon',
        description: 'Stremio addon to find and prioritize torrents from BitMagnet GraphQL API, leveraging TMDB/IMDb for metadata and multi-level sorting.',
        resources: ['meta', 'stream'], // Removed 'catalog' from resources
        types: ['movie', 'series'],
        catalogs: [], // Removed catalog definitions, now an empty array
        idPrefixes: ['tt'], // Indicates support for IMDb IDs
        behaviorHints: {
            p2p: true, // Explicitly tell Stremio this addon provides P2P content.
            // This is important if you want to provide high-quality streams without excessive buffering
            // By default, Stremio will proxy streams if this is not set.
            // Setting this to true means Stremio will attempt direct P2P connection via magnet link.
            // For details, see: [https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/stream.md](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/stream.md)
            // "bittorrent": true // This is usually applied per stream, not globally in manifest.
        }
    };
}

/**
 * Helper function to fetch metadata from both TMDB and OMDb in parallel
 * and combine/prioritize the results.
 * @param {string} imdbId - The IMDb ID.
 * @param {string} type - 'movie' or 'series'.
 * @returns {object|null} Combined metadata object or null if none found.
 */
async function fetchCombinedMetadata(imdbId, type) {
    const [tmdbResult, omdbResult] = await Promise.allSettled([
        getTmdbMetadata(imdbId, type),
        getOmdbMetadata(imdbId)
    ]);

    let tmdbData = tmdbResult.status === 'fulfilled' ? tmdbResult.value : null;
    let omdbData = omdbResult.status === 'fulfilled' ? omdbResult.value : null;

    // Prioritize TMDB data if available and has a title/name
    if (tmdbData && (tmdbData.title || tmdbData.name)) {
        console.log(`Metadata found (TMDB primary) for ${imdbId}).`);
        // Ensure TMDB data also has a 'year' property derived from its dates for consistency
        const tmdbYear = tmdbData.release_date ? parseInt(tmdbData.release_date.substring(0, 4), 10) :
                         (tmdbData.first_air_date ? parseInt(tmdbData.first_air_date.substring(0, 4), 10) : null);
        return { ...tmdbData, year: tmdbYear };
    }

    // Fallback to OMDb data if TMDB failed or didn't provide enough info
    if (omdbData && omdbData.Title && omdbData.Response === 'True') {
        console.log(`Metadata found (OMDb fallback) for ${imdbId}).`);
        // Map OMDb data to a structure similar to TMDB for consistency
        let omdbYear = null;
        // Prioritize parsing from 'Released' field as it's a full date string, which is more reliable for exact year.
        if (omdbData.Released && omdbData.Released !== 'N/A') {
            try {
                const releaseDate = new Date(omdbData.Released);
                if (!isNaN(releaseDate.getFullYear())) { // Check if it's a valid date
                    omdbYear = releaseDate.getFullYear();
                }
            } catch (e) {
                console.warn(`Could not parse OMDb Released date "${omdbData.Released}":`, e.message);
            }
        }
        
        // If year couldn't be derived from 'Released', try 'Year' field
        if (omdbYear === null && omdbData.Year && omdbData.Year !== 'N/A') {
            const yearMatch = omdbData.Year.match(/\d{4}/); // This regex gets the first four digits
            if (yearMatch) {
                omdbYear = parseInt(yearMatch[0], 10);
            }
        }
        
        const genres = omdbData.Genre && omdbData.Genre !== 'N/A' ? omdbData.Genre.split(', ').map(g => ({ name: g })) : [];
        const runtime = omdbData.Runtime && omdbData.Runtime !== 'N/A' && omdbData.Runtime !== '0 min' ? omdbData.Runtime : null;
        const imdbRating = omdbData.imdbRating && omdbData.imdbRating !== 'N/A' ? parseFloat(omdbData.imdbRating) : null;

        return {
            id: omdbData.imdbID,
            title: omdbData.Title,
            name: omdbData.Title, // Use name for series consistent with TMDB
            release_date: omdbData.Released && omdbData.Released !== 'N/A' ? omdbData.Released : null, // For movies
            first_air_date: omdbData.Released && omdbData.Released !== 'N/A' ? omdbData.Released : null, // For series
            year: omdbYear, // Explicitly parsed year
            overview: omdbData.Plot && omdbData.Plot !== 'N/A' ? omdbData.Plot : null,
            genres: genres, 
            poster_path: omdbData.Poster && omdbData.Poster !== 'N/A' ? omdbData.Poster : null,
            backdrop_path: null, // OMDb doesn't provide backdrop_path directly
            runtime: runtime,
            vote_average: imdbRating,
            // For series, if totalSeasons is available from OMDb, create dummy seasons for structure
            seasons: omdbData.Type === 'series' && omdbData.totalSeasons && omdbData.totalSeasons !== 'N/A' && parseInt(omdbData.totalSeasons) > 0
                ? Array.from({ length: parseInt(omdbData.totalSeasons) }, (_, i) => ({ season: i + 1 })) 
                : undefined
        };
    }

    console.warn(`No metadata found from TMDB or OMDb for ${imdbId}).`);
    return null;
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
        const tmdbResults = await searchTmdb(search, type); // Still use searchTmdb, no OMDb search yet
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
    const cacheKey = `combined_meta_${type}_${id}`;
    let combinedMetadata = tmdbCache.get(cacheKey);

    if (!combinedMetadata) {
        combinedMetadata = await fetchCombinedMetadata(id, type);
        if (combinedMetadata) {
            tmdbCache.set(cacheKey, combinedMetadata);
        }
    }

    if (!combinedMetadata) {
        console.warn(`No metadata found for ${id} from any source.`);
        return { meta: null };
    }

    const meta = {
        id: id,
        type: type,
        name: combinedMetadata.title || combinedMetadata.name,
        poster: combinedMetadata.poster_path ? `https://image.tmdb.org/t/p/w500${combinedMetadata.poster_path}` : null,
        posterShape: 'regular',
        background: combinedMetadata.backdrop_path ? `https://image.tmdb.org/t/p/original${combinedMetadata.backdrop_path}` : null,
        description: combinedMetadata.overview,
        genres: combinedMetadata.genres ? combinedMetadata.genres.map(g => g.name || g) : [], // Ensure genres are array of strings
        releaseInfo: combinedMetadata.release_date ? combinedMetadata.release_date.substring(0, 4) : (combinedMetadata.first_air_date ? combinedMetadata.first_air_date.substring(0, 4) : ''),
        runtime: combinedMetadata.runtime ? `${combinedMetadata.runtime} min` : undefined,
        imdbRating: combinedMetadata.vote_average ? `${combinedMetadata.vote_average.toFixed(1)}/10` : undefined,
        videos: type === 'series' && combinedMetadata.seasons ? combinedMetadata.seasons.flatMap(season =>
            // Check if episodes exist for the season object in combinedMetadata
            // OMDb might not provide episodes, so only map if available.
            (season.episodes && Array.isArray(season.episodes)) ? season.episodes.map(episode => ({
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
 * Parses episode information from a torrent name or BitMagnet's episodes label.
 * @param {string} torrentName - The full torrent name.
 * @param {object} torrentContentEpisodes - The episodes object from BitMagnet's content (can have label and seasons array).
 * @returns {{season: number|null, episodes: number[]}|null} Parsed season and episode numbers, or null if not found.
 */
function parseTorrentEpisodeData(torrentName, torrentContentEpisodes) {
    const parsedData = [];
    const seenCombos = new Set(); // To avoid duplicates if multiple regexes match the same thing

    // Helper to add data if unique
    const addData = (s, eps) => {
        // Ensure episodes are sorted and unique for consistent key generation
        const uniqueSortedEps = [...new Set(eps)].sort((a, b) => a - b);
        const key = `${s}-${JSON.stringify(uniqueSortedEps)}`;
        if (!seenCombos.has(key)) {
            parsedData.push({ season: s, episodes: uniqueSortedEps });
            seenCombos.add(key);
        }
    };

    // 1. Prioritize BitMagnet's structured episodes
    if (torrentContentEpisodes && Array.isArray(torrentContentEpisodes.seasons)) {
        torrentContentEpisodes.seasons.forEach(sData => {
            if (sData.season !== null && sData.season !== undefined) {
                const s = sData.season;
                const eps = (sData.episodes && Array.isArray(sData.episodes)) ? sData.episodes : [];
                addData(s, eps);
            }
        });
        // If structured data exists, prefer it and don't proceed with name parsing
        // This is a design choice. If you want to augment structured data with name parsing, remove this return.
        if (parsedData.length > 0) return parsedData;
    }

    const nameLower = torrentName.toLowerCase();

    // Regex patterns and their parsing logic (order matters for overlapping matches)
    const patterns = [
        // SXXEXX (single episode, e.g., S01E15, s1e1)
        {
            regex: /s(\d{1,3})e(\d{1,3})/g,
            parse: (match) => ({ season: parseInt(match[1], 10), episodes: [parseInt(match[2], 10)] })
        },
        // SXXE(YY-ZZ) (episode range without 'EP', e.g., s1e1-12)
        {
            regex: /s(\d{1,3})e(\d{1,3})(?:-|–)(\d{1,3})/g,
            parse: (match) => {
                const s = parseInt(match[1], 10);
                const startEp = parseInt(match[2], 10);
                const endEp = parseInt(match[3], 10);
                const eps = [];
                for (let i = startEp; i <= endEp; i++) {
                    eps.push(i);
                }
                return { season: s, episodes: eps };
            }
        },
        // SXXEP(YY-ZZ) or SXXEPYY-ZZ (episode range with 'EP', e.g., S01EP(13-16))
        {
            regex: /s(\d{1,3})\s*ep\(?(\d{1,3})(?:-|–)(\d{1,3})\)?/g,
            parse: (match) => {
                const s = parseInt(match[1], 10);
                const startEp = parseInt(match[2], 10);
                const endEp = parseInt(match[3], 10);
                const eps = [];
                for (let i = startEp; i <= endEp; i++) {
                    eps.push(i);
                }
                return { season: s, episodes: eps };
            }
        },
        // Word-based "Season X Episode Y" or "Season X Ep Y"
        {
            regex: /season\s*(\d{1,3})(?:\s*episode|\s*ep)\s*(\d{1,3})/g,
            parse: (match) => ({ season: parseInt(match[1], 10), episodes: [parseInt(match[2], 10)] })
        },
        // SXX-SYY (Season ranges, e.g., S01-S06) - treating each as a season pack
        {
            regex: /s(\d{1,3})(?:-|–)s(\d{1,3})/g,
            parse: (match) => {
                const startSeason = parseInt(match[1], 10);
                const endSeason = parseInt(match[2], 10);
                const seasonPacks = [];
                for (let i = startSeason; i <= endSeason; i++) {
                    seasonPacks.push({ season: i, episodes: [] }); // Empty episodes for season pack
                }
                return seasonPacks; // Return an array of season packs to be flattened
            }
        },
        // "Season X-Y" (Season ranges, e.g., Season 1-3) - treating each as a season pack
        {
            regex: /season\s*(\d{1,3})(?:-|–)(\d{1,3})/g,
            parse: (match) => {
                const startSeason = parseInt(match[1], 10);
                const endSeason = parseInt(match[2], 10);
                const seasonPacks = [];
                for (let i = startSeason; i <= endSeason; i++) {
                    seasonPacks.push({ season: i, episodes: [] }); // Empty episodes for season pack
                }
                return seasonPacks; // Return an array of season packs to be flattened
            }
        },
        // SXX (Season pack, e.g., S01, S1) - ensure it's not part of SXXEXX
        // This regex now specifically looks for 'S' followed by digits, not immediately followed by 'E' or another digit (for episode)
        {
            regex: /s(\d{1,3})(?![eE\d])/g,
            parse: (match) => ({ season: parseInt(match[1], 10), episodes: [] })
        },
        // "Season X" (Season pack, e.g., Season 1) - ensure it's not part of "Season X Episode Y"
        {
            regex: /season\s*(\d{1,3})(?!(?:\s*episode|\s*ep|\d))/g, // Not followed by "episode", "ep", or digits
            parse: (match) => ({ season: parseInt(match[1], 10), episodes: [] })
        },
        // EPXX (single episode without explicit season) - lowest priority
        {
            regex: /ep(\d{1,3})/g,
            parse: (match) => ({ season: null, episodes: [parseInt(match[1], 10)] }) // Season remains null
        }
    ];

    patterns.forEach(pattern => {
        const matches = nameLower.matchAll(pattern.regex);
        for (const match of matches) {
            const result = pattern.parse(match);
            if (Array.isArray(result)) { // Handle patterns that return multiple results (like season ranges)
                result.forEach(item => addData(item.season, item.episodes));
            } else {
                addData(result.season, result.episodes);
            }
        }
    });

    return parsedData.length > 0 ? parsedData : [];
}

/**
 * Determines if a torrent is considered "low quality" based on its resolution and common low-quality tags.
 * @param {object} torrentContent - The torrent content object from BitMagnet.
 * @returns {boolean} True if the torrent is low quality, false otherwise.
 */
function isLowQualityTorrent(torrentContent) {
    const torrentNameLower = torrentContent.torrent.name.toLowerCase();
    const videoResolution = torrentContent.videoResolution;
    const videoSource = torrentContent.videoSource ? torrentContent.videoSource.toLowerCase() : '';
    const videoModifier = torrentContent.videoModifier ? torrentContent.videoModifier.toLowerCase() : '';

    // Check for low resolutions
    if (videoResolution) {
        const resNumeric = parseInt(videoResolution.replace('V', ''), 10);
        if (resNumeric <= 576 && resNumeric !== 720 && resNumeric !== 1080 && resNumeric !== 1440 && resNumeric !== 2160 && resNumeric !== 4320) {
            return true;
        }
    }

    // Check for low-quality sources/modifiers/keywords
    const lowQualityKeywords = ['telecine', 'ts', 'cam', 'hd-ts', 'hd-cam', 'web-rip'];
    if (lowQualityKeywords.some(keyword => torrentNameLower.includes(keyword) || videoSource.includes(keyword) || videoModifier.includes(keyword))) {
        return true;
    }

    return false;
}

/**
 * Determines if a torrent's language matches the preferred language.
 * @param {object} torrentContent - The torrent content object from BitMagnet.
 * @param {string} preferredLanguage - The preferred language code (e.g., 'eng', 'hin').
 * @returns {boolean} True if the torrent contains the preferred language, false otherwise.
 */
function hasPreferredLanguage(torrentContent, preferredLanguage) {
    if (!preferredLanguage || preferredLanguage.trim() === '') {
        return false; // No preferred language set
    }
    const lowerPreferredLanguage = preferredLanguage.toLowerCase();
    
    // Check BitMagnet's `languages` array
    if (torrentContent.languages && Array.isArray(torrentContent.languages)) {
        if (torrentContent.languages.some(lang => lang.name.toLowerCase() === lowerPreferredLanguage)) {
            return true;
        }
    }

    // Fallback: Check torrent name for common language indicators
    const torrentNameLower = torrentContent.torrent.name.toLowerCase();
    // Common language tags in torrent names (can be expanded)
    const languageKeywords = {
        'english': ['eng', 'english', 'en'],
        'hindi': ['hin', 'hindi'],
        'tamil': ['tam', 'tamil'],
        'telugu': ['tel', 'telugu'],
        'malayalam': ['mal', 'malayalam'],
        'kannada': ['kan', 'kannada'],
        'french': ['fre', 'french', 'fr'],
        'spanish': ['spa', 'spanish', 'es'],
        'german': ['ger', 'german', 'de'],
        'japanese': ['jpn', 'japanese', 'ja'],
        'korean': ['kor', 'korean', 'ko'],
        'mandarin': ['man', 'mandarin', 'cmn'],
        'cantonese': ['can', 'cantonese', 'yue'],
        'arabic': ['ara', 'arabic', 'ar'],
        'russian': ['rus', 'russian', 'ru'],
        'portuguese': ['por', 'portuguese', 'pt'],
        'italian': ['ita', 'italian', 'it'],
        'dutch': ['dut', 'dutch', 'nl'],
        'swedish': ['swe', 'swedish', 'sv'],
        'norwegian': ['nor', 'norwegian', 'no'],
        'danish': ['dan', 'danish', 'da'],
        'finnish': ['fin', 'finnish', 'fi'],
        'polish': ['pol', 'polish', 'pl'],
        'turkish': ['tur', 'turkish', 'tr'],
        'thai': ['thi', 'thai', 'th'],
        'vietnamese': ['vie', 'vietnamese', 'vi'],
        'indonesian': ['ind', 'indonesian', 'id'],
        'hebrew': ['heb', 'hebrew', 'he'],
        'greek': ['gre', 'greek', 'el'],
        'czech': ['cze', 'czech', 'cs'],
        'hungarian': ['hun', 'hungarian', 'hu'],
    };

    const preferredLanguageAliases = languageKeywords[lowerPreferredLanguage] || [lowerPreferredLanguage];

    for (const alias of preferredLanguageAliases) {
        // Look for the alias as a standalone word or surrounded by common separators
        const regex = new RegExp(`[\\s.\\[\\(-]${alias}[\\s.\\]\\)-]`, 'i');
        if (torrentNameLower.includes(alias) || regex.test(torrentNameLower)) {
            return true;
        }
    }

    return false;
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

    let combinedMetadata;
    try {
        combinedMetadata = await fetchCombinedMetadata(imdbId, type);
    } catch (error) {
        console.error(`Error fetching combined metadata for ${imdbId}:`, error.message);
        return { streams: [] };
    }

    // Define baseContentTitle here so it's accessible within the map function below
    const baseContentTitle = (combinedMetadata && (combinedMetadata.title || combinedMetadata.name)) ? 
                           (combinedMetadata.title || combinedMetadata.name) : 
                           imdbId;
    
    let yearForSearch = null;
    if (combinedMetadata) {
        if (combinedMetadata.year) { // Prioritize the explicitly parsed year from combinedMetadata
            yearForSearch = combinedMetadata.year;
        } else if (combinedMetadata.release_date) {
            yearForSearch = parseInt(combinedMetadata.release_date.substring(0, 4), 10);
        } else if (combinedMetadata.first_air_date) {
            yearForSearch = parseInt(combinedMetadata.first_air_date.substring(0, 4), 10);
        }
    }
    
    // Ensure titleForSearch is not empty or just spaces
    if (!baseContentTitle || baseContentTitle.trim() === '') {
        console.warn(`No valid title could be determined for ${imdbId}. Cannot search BitMagnet.`);
        return { streams: [] };
    }

    let bitMagnetResults = [];
    const seenInfoHashes = new Set();

    // Strategy 1: Broad Search Term (title + year in queryString, no year filter in facets)
    // This often yields better results if BitMagnet's internal indexing isn't strict on year facets.
    const broadQueryString = yearForSearch ? `${baseContentTitle} ${yearForSearch}` : baseContentTitle;
    try {
        const broadResults = await searchBitMagnet({
            queryString: broadQueryString,
            contentType: type === 'movie' ? 'movie' : 'tv_show',
            releaseYear: null // Explicitly set to null to avoid filtering in BitMagnet's facets
        });
        console.log(`Broad search for "${broadQueryString}" (${yearForSearch || 'Unknown Year'}) found ${broadResults.length} results.`);
        broadResults.forEach(item => {
            if (!seenInfoHashes.has(item.infoHash)) {
                bitMagnetResults.push(item);
                seenInfoHashes.add(item.infoHash);
            }
        });
    } catch (error) {
        console.error(`Error in broad BitMagnet search for "${broadQueryString}":`, error.message);
    }

    // Strategy 2: Fallback (only if no results from broad search)
    // For movies, if year is available, still try with year filter in fallback.
    // For series, the fallbackReleaseYear remains null, as per the user's request.
    if (bitMagnetResults.length === 0) {
        let fallbackReleaseYear = null;
        if (type === 'movie' && yearForSearch !== null && !isNaN(yearForSearch)) {
            fallbackReleaseYear = yearForSearch;
        }

        try {
            const fallbackResults = await searchBitMagnet({
                queryString: baseContentTitle,
                releaseYear: fallbackReleaseYear, // Apply conditional year filter based on type
                contentType: type === 'movie' ? 'movie' : 'tv_show',
            });
            console.log(`Fallback search for "${baseContentTitle}" with year ${fallbackReleaseYear || 'None'} found ${fallbackResults.length} results.`);
            fallbackResults.forEach(item => {
                if (!seenInfoHashes.has(item.infoHash)) {
                    bitMagnetResults.push(item);
                    seenInfoHashes.add(item.infoHash);
                }
            });
        } catch (error) {
            console.error(`Error in fallback BitMagnet search for "${baseContentTitle}" (${fallbackReleaseYear || 'no year'}):`, error.message);
        }
    }
    
    // Final check after all strategies
    if (bitMagnetResults.length === 0) {
        console.log(`No BitMagnet results found for "${baseContentTitle}" (${yearForSearch || 'Unknown Year'}) after all strategies.`);
        return { streams: [] };
    }

    // 1. Parse episode data for each torrent in the combined results
    bitMagnetResults.forEach(torrentContent => {
        if (type === 'series') {
            torrentContent._parsedEpisodeData = parseTorrentEpisodeData(torrentContent.torrent.name, torrentContent.episodes);
            // console.log(`Parsed episode data for ${torrentContent.torrent.name}:`, torrentContent._parsedEpisodeData);
        }
    });

    // 2. Filter results based on MAX_TORRENT_SIZE_GB
    let currentTorrents = bitMagnetResults; // Start with all results
    const maxTorrentSizeGB = parseFloat(config.MAX_TORRENT_SIZE_GB);
    if (!isNaN(maxTorrentSizeGB) && maxTorrentSizeGB > 0) {
        currentTorrents = currentTorrents.filter(torrentContent => {
            const sizeGB = torrentContent.torrent.size / (1024 * 1024 * 1024);
            return sizeGB <= maxTorrentSizeGB;
        });
        console.log(`Filtered to ${currentTorrents.length} torrents after applying size limit (${maxTorrentSizeGB} GB).`);
    }

    // 3. Sort by seeders DESC (Primary sort based on current list)
    currentTorrents.sort((a, b) => {
        const seedersA = a.seeders || 0;
        const seedersB = b.seeders || 0;
        return seedersB - seedersA; // Sort by seeders first (most to least)
    });
    console.log(`Sorted by seeders. First few:`, currentTorrents.slice(0, 5).map(t => ({ name: t.torrent.name, seeders: t.seeders })));


    // 4. Conditional Quality Filtering (applied to the seeders-sorted list)
    let hasHighQualityTorrents = false;
    for (const torrentContent of currentTorrents) { // Check within the current list
        if (!isLowQualityTorrent(torrentContent)) {
            hasHighQualityTorrents = true;
            break;
        }
    }

    if (hasHighQualityTorrents) {
        currentTorrents = currentTorrents.filter(torrentContent => !isLowQualityTorrent(torrentContent));
        console.log(`Removed low-quality torrents after seeders sort. Remaining: ${currentTorrents.length}`);
    } else {
        console.log('No high-quality torrents found after seeders sort, including all qualities.');
    }


    // 5. Apply episode filtering (for series) to the conditionally quality-filtered list
    let relevantTorrents = currentTorrents;
    if (type === 'series' && season && episode) {
        relevantTorrents = relevantTorrents.filter(torrentContent => {
            const parsedDataArray = torrentContent._parsedEpisodeData;
            if (!parsedDataArray || parsedDataArray.length === 0) {
                return false; // No episode data parsed for this torrent
            }

            // Check if any of the parsed season/episode patterns match the requested season and episode
            return parsedDataArray.some(parsed => {
                if (parsed.season === null) {
                    return false; // Cannot filter by season if season is unknown for this entry
                }

                if (parsed.season === season) {
                    // If it's a season pack (episodes array is empty for this parsed entry)
                    // AND the requested episode is not null (i.e., we are looking for a specific episode within this season)
                    if (parsed.episodes.length === 0 && episode !== null) {
                        return true; // This season pack is relevant for any episode in that season
                    }
                    // If specific episodes are listed, check if the requested episode is in that list
                    // And ensure episode is not null (i.e., we are looking for a specific episode)
                    if (parsed.episodes.includes(episode) && episode !== null) {
                        return true;
                    }
                }
                return false; // Season does not match for this specific parsed entry
            });
        });
        console.log(`Filtered to ${relevantTorrents.length} relevant torrents for S${season}E${episode}`);
    }

    if (relevantTorrents.length === 0) {
        return { streams: [] };
    }

    // Get preferred language from config (environment variable)
    const preferredLanguage = (process.env.PREFERRED_LANGUAGE || '').toLowerCase(); // Ensure it's lowercase for comparison

    // 6. Sort by Preferred Language (Pass 2)
    // Torrents with preferred language come first, then others.
    if (preferredLanguage) {
        relevantTorrents.sort((a, b) => {
            const aHasPreferredLanguage = hasPreferredLanguage(a, preferredLanguage);
            const bHasPreferredLanguage = hasPreferredLanguage(b, preferredLanguage);

            if (aHasPreferredLanguage && !bHasPreferredLanguage) {
                return -1; // A comes before B
            } else if (!aHasPreferredLanguage && bHasPreferredLanguage) {
                return 1; // B comes before A
            }
            return 0; // Maintain original order (from seeders sort) if both/neither have preferred language
        });
        console.log(`Sorted by preferred language (${preferredLanguage}). First few:`, relevantTorrents.slice(0, 5).map(t => ({ name: t.torrent.name, hasPrefLang: hasPreferredLanguage(t, preferredLanguage), seeders: t.seeders })));
    }


    // 7. Re-Sort by Quality Score (Pass 3 - final sort)
    // This re-sorts the list (which is already sorted by seeders and then by preferred language)
    // to finally prioritize quality.
    relevantTorrents.sort((a, b) => {
        const scoreA = calculateQualityScore(a);
        const scoreB = calculateQualityScore(b);
        return scoreB - scoreA; // Sort by quality score (highest to lowest)
    });
    console.log(`Final list re-sorted by quality. First few:`, relevantTorrents.slice(0, 5).map(t => ({ name: t.torrent.name, score: calculateQualityScore(t), seeders: t.seeders })));


    // 8. Limit results to a configurable number
    const maxStreams = parseInt(config.MAX_STREAMS_PER_ITEM, 10) || 10; // Default to 10 if not set or invalid
    const topTorrents = relevantTorrents.slice(0, maxStreams);

    // Get the dynamically fetched best public trackers
    const publicTrackers = await getTrackers();

    const streams = topTorrents.map(torrentContent => {
        // Construct the Stremio 'name' field: "Bitmagnet{Emoji}-{Resolution}"
        const resolution = torrentContent.videoResolution ? torrentContent.videoResolution.replace('V', '') : 'Unknown';
        const streamName = `BitMagnet 🧲-${resolution}`; // Moved resolution here

        // Construct the Stremio 'title' field, now as a single line with other metadata
        let titleParts = [];
        let mainTitle = '';

        if (type === 'movie' && (combinedMetadata && (combinedMetadata.year || combinedMetadata.release_date || combinedMetadata.Year))) {
            const displayYear = combinedMetadata.year || 
                                (combinedMetadata.release_date ? combinedMetadata.release_date.substring(0, 4) : 
                                (combinedMetadata.Year ? combinedMetadata.Year.match(/\d{4}/)?.[0] : null));
            mainTitle = `${baseContentTitle} (${displayYear})`;
        } else if (type === 'series' && season && episode) {
            mainTitle = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} ${baseContentTitle}`;
        } else {
            mainTitle = baseContentTitle;
        }
        titleParts.push(mainTitle);

        // Add Size
        const sizeGB = (torrentContent.torrent.size / (1024 * 1024 * 1024));
        let sizeInfo;
        if (sizeGB >= 1) {
            sizeInfo = `💾 ${sizeGB.toFixed(1)}G`;
        } else {
            sizeInfo = `💾 ${(sizeGB * 1024).toFixed(0)}M`;
        }
        titleParts.push(sizeInfo);

        // Add Seeders
        if (torrentContent.seeders !== undefined) {
            titleParts.push(`👤 ${torrentContent.seeders}`);
        }

        // Removed Resolution from here as it's now in stream.name

        // Add Codec
        if (torrentContent.videoCodec) {
            titleParts.push(`🎬 ${torrentContent.videoCodec}`);
        }

        // Add Source/Modifier
        if (torrentContent.videoModifier) {
            titleParts.push(`💿 ${torrentContent.videoModifier}`);
        } else if (torrentContent.videoSource) {
            titleParts.push(`💿 ${torrentContent.videoSource}`);
        } else {
            const torrentNameLower = torrentContent.torrent.name.toLowerCase();
            if (torrentNameLower.includes('web-dl') || torrentNameLower.includes('webdl')) titleParts.push(`💿 WEB-DL`);
            else if (torrentNameLower.includes('bluray')) titleParts.push(`💿 BluRay`);
            else if (torrentNameLower.includes('hdrip')) titleParts.push(`💿 HDRip`);
            else if (torrentNameLower.includes('dvdrip')) titleParts.push(`💿 DVDRip`);
            else if (torrentNameLower.includes('hdtv')) titleParts.push(`💿 HDTV`);
            else if (torrentNameLower.includes('ts')) titleParts.push(`💿 TS`);
            else if (torrentNameLower.includes('cam')) titleParts.push(`💿 CAM`);
        }

        // Add 10bit
        if ((torrentContent.torrent.tagNames && torrentContent.torrent.tagNames.some(tag => tag.toLowerCase().includes('10bit'))) || torrentContent.torrent.name.toLowerCase().includes('10bit')) {
            titleParts.push(`⭐ 10bit`);
        }

        // Add Audio
        let audioQuality = '';
        const torrentNameLower = torrentContent.torrent.name.toLowerCase();
        if (torrentNameLower.includes('atmos')) audioQuality = 'Atmos';
        else if (torrentNameLower.includes('dts-hd')) audioQuality = 'DTS-HD';
        else if (torrentNameLower.includes('truehd')) audioQuality = 'TrueHD';
        else if (torrentNameLower.includes('dts')) audioQuality = 'DTS';
        else if (torrentNameLower.includes('eac3') || torrentNameLower.includes('ddp')) audioQuality = 'EAC3';
        else if (torrentNameLower.includes('ac3')) audioQuality = 'AC3';
        else if (torrentNameLower.includes('aac')) audioQuality = 'AAC';
        else if (torrentNameLower.includes('5.1')) audioQuality = '5.1';
        else if (torrentNameLower.includes('2.0') || torrentNameLower.includes('stereo')) audioQuality = '2.0';
        if (audioQuality) {
            titleParts.push(`🔊 ${audioQuality}`);
        }

        // Add Language
        if (torrentContent.languages && torrentContent.languages.length > 0) {
            const languageCodes = torrentContent.languages.map(lang => {
                switch(lang.name.toLowerCase()) {
                    case 'english': return 'ENG'; case 'tamil': return 'TAM'; case 'hindi': return 'HIN';
                    case 'telugu': return 'TEL'; case 'malayalam': return 'MAL'; case 'kannada': return 'KAN';
                    case 'french': return 'FRE'; case 'spanish': return 'SPA'; case 'german': return 'GER';
                    case 'japanese': return 'JPN'; case 'korean': return 'KOR'; case 'mandarin': return 'MAN';
                    case 'cantonese': return 'CAN'; case 'arabic': return 'ARA'; case 'russian': return 'RUS';
                    case 'portuguese': return 'POR'; case 'italian': return 'ITA'; case 'dutch': return 'DUT';
                    case 'swedish': return 'SWE'; case 'norwegian': return 'NOR'; case 'danish': return 'DAN';
                    case 'finnish': return 'FIN'; case 'polish': return 'POL'; case 'turkish': return 'TUR';
                    case 'thai': return 'THI'; case 'vietnamese': return 'VIE'; case 'indonesian': return 'IND';
                    case 'hebrew': return 'HEB'; case 'greek': return 'GRE'; case 'czech': return 'CZE';
                    case 'hungarian': return 'HUN';
                    default: return lang.name.toUpperCase().substring(0, 3);
                }
            });
            titleParts.push(`🗣️ ${languageCodes.join('|')}`);
        }
        
        let streamTitle = titleParts.filter(Boolean).join(' | '); // Join all parts on a single line

        let parsedMagnet;
        const bitmagnetInfoHash = torrentContent.infoHash;
        let dhtInfoHash = bitmagnetInfoHash ? String(bitmagnetInfoHash).toLowerCase() : '';

        let announceTrackers = [];

        try {
            parsedMagnet = parseTorrent(torrentContent.torrent.magnetUri);
            if (parsedMagnet && Array.isArray(parsedMagnet.announce)) {
                announceTrackers = parsedMagnet.announce;
            } else {
                console.warn(`parse-torrent could not extract announce URLs from magnet URI for ${torrentContent.infoHash}. (This is often normal for some magnet links.)`);
            }
        } catch (e) {
            console.error(`Error parsing magnet URI for ${torrentContent.infoHash}:`, e.message);
        }

        const allTrackers = new Set([
            ...announceTrackers.map(t => `tracker:${t}`),
            ...publicTrackers.map(t => `tracker:${t}`)
        ]);
        
        if (dhtInfoHash) {
            allTrackers.add(`dht:${dhtInfoHash}`);
        } else {
            console.warn(`Missing infoHash for torrentContent ID: ${torrentContent.id}. DHT source will be omitted.`);
        }

        const sources = Array.from(allTrackers);

        return {
            infoHash: torrentContent.infoHash,
            name: streamName,
            title: streamTitle, // Now includes all detailed info
            type: torrentContent.contentType,
            quality: torrentContent.videoResolution ? torrentContent.videoResolution.replace('V', '') : 'Unknown',
            seeders: torrentContent.seeders,
            sources: sources,
            behaviorHints: {
                bittorrent: true,
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
