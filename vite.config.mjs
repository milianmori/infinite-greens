import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
	build: {
		rollupOptions: {
			input: {
				index: resolve(__dirname, 'index.html'),
				control: resolve(__dirname, 'control.html'),
				mixer: resolve(__dirname, 'mixer.html'),
				randomizer: resolve(__dirname, 'randomizer.html'),
				spatial: resolve(__dirname, 'spatial.html')
			}
		}
	}
});


