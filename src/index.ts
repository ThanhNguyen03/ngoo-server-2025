import NGOO_API from './app';

// TODO: Connect Database

NGOO_API.payload().catch((error) => {
  console.error('Application error: ', error);
  // TODO: Exit application
});
