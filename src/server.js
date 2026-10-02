const config = require('./config');
const app = require('./app');
const { startJobs } = require('./jobs');

app.listen(config.port, config.host, () => {
  console.log(`Møteromsbooking kjører på http://${config.host}:${config.port}`);
  startJobs();
});
