#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

module.exports = function(context) {
    console.log('Executing copy_android_files.cjs hook...');

    const platformRoot = path.join(context.opts.projectRoot, 'platforms/android');
    const projectRoot = context.opts.projectRoot;

    // Source files
    const mainActivitySource = path.join(projectRoot, 'cordova_hooks/android/MainActivity.java');
    const webAppInterfaceSource = path.join(projectRoot, 'cordova_hooks/android/WebAppInterface.java');

    // Destination directory
    // The package name is io.spritex.app, so the directory structure is io/spritex/app
    const destinationDir = path.join(platformRoot, 'app/src/main/java/io/spritex/app');

    // Check if the destination directory exists
    if (fs.existsSync(destinationDir)) {
        console.log(`Destination directory found: ${destinationDir}`);
        
        // Define destination paths
        const mainActivityDest = path.join(destinationDir, 'MainActivity.java');
        const webAppInterfaceDest = path.join(destinationDir, 'WebAppInterface.java');

        // Copy MainActivity.java
        if (fs.existsSync(mainActivitySource)) {
            fs.copyFileSync(mainActivitySource, mainActivityDest);
            console.log(`Successfully copied MainActivity.java to ${mainActivityDest}`);
        } else {
            console.error(`Error: Source file not found at ${mainActivitySource}`);
        }

        // Copy WebAppInterface.java
        if (fs.existsSync(webAppInterfaceSource)) {
            fs.copyFileSync(webAppInterfaceSource, webAppInterfaceDest);
            console.log(`Successfully copied WebAppInterface.java to ${webAppInterfaceDest}`);
        } else {
            console.error(`Error: Source file not found at ${webAppInterfaceSource}`);
        }
    } else {
        console.error(`Error: Destination directory not found at ${destinationDir}. Android platform may not be set up correctly.`);
    }
};
