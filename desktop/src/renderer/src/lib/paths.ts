/** Route of a video's detail page. Keys are absolute Windows paths, so they are always URI-encoded. */
export const videoPath = (key: string): string => `/video/${encodeURIComponent(key)}`
