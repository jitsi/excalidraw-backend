module.exports = {
    env: {
    node: true,
    es2021: true,
    },

    extends: [
        '@jitsi/eslint-config',
        '@jitsi/eslint-config/jsdoc',
        '@jitsi/eslint-config/typescript',
    ],
};
