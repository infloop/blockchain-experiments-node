import * as needle from 'needle';
import * as yargs from 'yargs';

const nodes = yargs.argv.nodes ? yargs.argv.nodes.split(',') : [];

const tuples = Array.from(Array((yargs.argv.t | 0) || 1).keys());

function addBlock(data: string) {
    tuples.forEach(tuple => {
        nodes.forEach(node => {
            let payload = {
                data: 'data:' + data + ' tuple:' + tuple
            };

            needle.post(node+'/mineBlock', payload, { json: true }, function(error, response) {
                if (!error && response.statusCode == 200) {
                    console.log(response.body);
                } else {
                    console.error(error || response.statusCode);
                }
            });
        });
    });
}

if (!yargs.argv.nodes) {
    console.log('Empty nodes, please pass --nodes parameter');
}

if (yargs.argv.data) {
    addBlock(yargs.argv.data);
} else {
    console.log('Empty data, please pass --data parameter');
}
